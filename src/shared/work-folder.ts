// "Work in a folder": a conversation's working folder, chosen from this computer when Prometheus
// runs on it. Pure rules (no DOM, no Electron), shared by the thread header's chip, main's picker
// and the headless smoke.
//
// WHAT A FOLDER IS HERE. Prometheus already lets a conversation be bound to a workspace
// (/api/sessions/{id}/workspace; the Checkpoints panel and the /workspace command set it by typing
// a path). The agent's file tools then read and write in that folder, from its next reply. This
// module adds two things: the folder a conversation is working in is ALWAYS shown, in the
// conversation's own header, and when Prometheus is on this computer the folder is chosen with the
// system's folder picker instead of a typed path.
//
// WHY ONLY ON THIS COMPUTER. A folder picker shows this computer's folders. A path it returns
// means something to Prometheus only when Prometheus is reading the same disk. When Prometheus is
// on another computer the chip still shows the folder (it is a folder THERE, and says so), and the
// picker is not offered.
//
// WHAT CHOOSING ONE GRANTS. The agent can read, change and delete files in that folder in that
// conversation. That is the point, and it is said in those words before anything is set. A folder
// that is really "everything" (the whole home folder, the disk, a system folder, the folders that
// hold keys and settings) is refused here: nobody means that by "work in a folder".

import type { SessionWorkspaceDTO } from './checkpoints'

/** Whether an address is this computer's own loopback: the only case where Prometheus is known to
 *  share this disk. A name that merely points here (a tailnet name, the computer's own LAN
 *  address) is not taken for it; the cost of that caution is typing the path instead. */
export function isThisComputer(apiBase: string | null | undefined): boolean {
  if (!apiBase) return false
  try {
    const host = new URL(apiBase).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

const clean = (p: string): string => {
  const t = p.trim().replace(/\\/g, '/')
  return t.length > 1 ? t.replace(/\/+$/, '') : t
}

/** A path as a person reads it: the home folder as `~`. */
export function folderDisplay(path: string, home: string | null | undefined): string {
  const p = clean(path)
  const h = home ? clean(home) : ''
  if (h && p === h) return '~'
  return h && p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

/** The folder's own name, for the chip: `…/Documents/Taxes 2026` is `Taxes 2026`. */
export function folderName(path: string): string {
  const p = clean(path)
  const last = p.slice(p.lastIndexOf('/') + 1)
  return last || p || '/'
}

/** Top-level folders of a disk that are the system's, not a person's work. */
const SYSTEM_DIRS = ['/system', '/library', '/applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/dev', '/proc', '/sys', '/boot', '/root', '/users', '/home', '/volumes', '/tmp', '/windows', '/program files']

/**
 * Why this folder can't be the working folder, in words, or '' when it can. Refused: the disk, the
 * home folder itself, a system folder, a folder directly under a system folder's root listing of
 * people (`/Users`, `/home`), and the hidden and Library folders at the top of home, which hold
 * keys and every app's settings. `home` is this computer's home folder.
 */
export function folderProblem(path: string, home: string | null | undefined): string {
  const p = clean(path)
  if (!p || !p.startsWith('/')) return 'That is not a folder Beacon can use.'
  const h = home ? clean(home) : ''
  const lower = p.toLowerCase()
  if (p === '/') return 'That is the whole disk. Choose one folder to work in.'
  if (h && p === h) return 'That is your whole home folder. Choose one folder inside it to work in.'
  if (h && h.startsWith(`${p}/`)) return 'That folder contains your home folder. Choose one folder inside your home folder.'
  if (SYSTEM_DIRS.some((d) => lower === d || (lower.startsWith(`${d}/`) && !(h && (p === h || p.startsWith(`${h}/`)))))) {
    return 'That is a system folder. Choose a folder of your own to work in.'
  }
  if (h && p.startsWith(`${h}/`)) {
    const top = p.slice(h.length + 1).split('/')[0]
    if (top.startsWith('.')) return `"${top}" holds settings and keys. Choose a folder with your work in it.`
    if (top.toLowerCase() === 'library') return 'The Library folder holds every app\'s settings. Choose a folder with your work in it.'
  }
  return ''
}

/** What the chip in a conversation's header says. */
export interface FolderChip {
  /** 'bound': working in a folder. 'none': no folder. 'hidden': nothing can be said (the daemon
   *  predates the route, the read failed, or it has not answered yet), so nothing is drawn. */
  state: 'bound' | 'none' | 'hidden'
  text: string
  /** The full line for the tooltip and the screen reader. */
  title: string
  /** The folder's path, when bound. */
  path: string | null
}

/** `where` is "this computer", or the other computer's name. */
export function folderChip(ws: SessionWorkspaceDTO | null | undefined, home: string | null | undefined, here: boolean, where: string): FolderChip {
  if (ws === undefined || ws === null) return { state: 'hidden', text: '', title: '', path: null }
  const bound = ws.source === 'session' ? (ws.workspace ?? ws.path ?? ws.cwd ?? null) : null
  const place = here ? 'on this computer' : where ? `on ${where}` : 'on the Prometheus computer'
  if (!bound || !String(bound).trim()) {
    return { state: 'none', text: 'No folder', title: 'This conversation is not working in a folder of yours.', path: null }
  }
  const path = clean(String(bound))
  const shown = here ? folderDisplay(path, home) : path
  return { state: 'bound', text: folderName(path), title: `Your assistant is working in ${shown}, ${place}.`, path }
}

/** What is asked before a folder is set. Says what is granted, where, and from when. */
export function folderConfirm(path: string, home: string | null | undefined): { title: string; body: string; action: string } {
  return {
    title: `Let your assistant work in ${folderDisplay(path, home)}?`,
    body: 'In this conversation it will be able to read, change and delete files in that folder, starting with its next reply. Nothing outside the folder is opened to it by this, and no other conversation is changed.',
    action: 'Use this folder'
  }
}

/** After a set that Prometheus answered. `resolved` is the path Prometheus says it bound (it
 *  follows links, so it can differ from what was chosen, and then both are shown). */
export function folderSetWords(chosen: string, resolved: string | null | undefined, home: string | null | undefined): { ok: boolean; words: string } {
  const r = (resolved ?? '').trim()
  if (!r) return { ok: false, words: 'Prometheus did not set the folder. Nothing has changed.' }
  const same = clean(r) === clean(chosen)
  return {
    ok: true,
    words: `Your assistant now works in ${folderDisplay(r, home)}${same ? '' : ` (the folder you chose leads there)`}, from its next reply. If it says it cannot open the folder, your computer may need to allow Prometheus to use it: on a Mac, System Settings → Privacy & Security → Files and Folders.`
  }
}

/** A failed set or clear, in words. Never a status line or a route. */
export function folderFailure(message: string): string {
  const m = (message ?? '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
  const status = /^HTTP (\d{3})\b/.exec(m)?.[1]
  if (status === '401' || status === '403') return 'This Beacon is not allowed to set a folder on this Prometheus. A Beacon that is an owner of it can.'
  if (status === '404') return 'This Prometheus is too old to work in a folder you choose. Update Prometheus, then try again.'
  if (status) {
    const said = / — ([\s\S]*)$/.exec(m)?.[1] ?? ''
    let detail = said
    try {
      const j = JSON.parse(said) as { error?: unknown }
      if (typeof j.error === 'string') detail = j.error
    } catch {
      /* not JSON: use it as it is */
    }
    return detail ? `Prometheus did not accept that folder: ${detail.slice(0, 200)}` : 'Prometheus did not accept that folder.'
  }
  return 'Beacon could not reach Prometheus to set the folder. Nothing has changed. Try again.'
}

/** What the popover says when the picker is not offered: Prometheus is on another computer. */
export function elsewhereWords(where: string): string {
  return `Prometheus runs on ${where || 'another computer'}, so the folder is one on that computer, and Beacon cannot show you its folders from here. To set one, type /workspace and the folder's path there as a message in this conversation.`
}

/** The picker's answer (main → the page). */
export type FolderPick = { kind: 'picked'; path: string } | { kind: 'cancelled' } | { kind: 'not-here' }

/** Where Prometheus is, and this computer's home folder for showing paths (main → the page). */
export interface FolderWhere {
  here: boolean
  home: string
}
