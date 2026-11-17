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
// "ON THIS COMPUTER" IS PROVED, NOT ASSUMED. A loopback address is only where Beacon reaches
// Prometheus: an SSH tunnel, a container's forwarded port and a VM all look the same, and a path
// like ~/Documents exists on both ends of most of them. So main proves a shared disk before the
// picker is ever offered: it makes a folder with a random name, asks Prometheus to accept that
// folder for a throwaway session id (Prometheus refuses a folder it cannot see), and takes the
// answer back (`hereVerdict`). Only "Prometheus saw the folder I just made" counts.
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

/** A path without its trailing slashes. Nothing else is changed: a backslash is an ordinary
 *  character in a POSIX name, and rewriting it would check a different folder than the one meant. */
const clean = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/**
 * What Prometheus's answer to the marker folder proves (see the header).
 *   'here'      it accepted the marker and named the same folder back: one disk.
 *   'elsewhere' it could not see the marker: Beacon reaches it through this computer (a tunnel,
 *               a container, a VM), but they do not share folders.
 *   'unknown'   anything else (refused for another reason, no answer): nothing is proved, and the
 *               picker is not offered on a guess.
 * `sent` and `answered` are the marker's real path and the `workspace` Prometheus returned.
 */
export function hereVerdict(r: { ok: true; sent: string; answered: unknown } | { ok: false; message: string }): 'here' | 'elsewhere' | 'unknown' {
  if (r.ok) return typeof r.answered === 'string' && clean(r.answered) === clean(r.sent) ? 'here' : 'unknown'
  return /^HTTP 400\b/.test(r.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')) && /not an existing directory/i.test(r.message) ? 'elsewhere' : 'unknown'
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

/** Top-level folders that are the system's, not a person's work: refused with everything in them. */
const SYSTEM_DIRS = ['/system', '/library', '/applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/dev', '/proc', '/sys', '/boot', '/root', '/lib', '/lib32', '/lib64', '/snap', '/nix', '/cores', '/run']
/** Where disks and other people's folders are mounted. The folder itself and each thing directly in
 *  it (a whole disk, a whole person) are refused; a folder further down is someone's work. */
const MOUNT_DIRS = ['/volumes', '/media', '/mnt', '/users', '/home']
/** Cloud folders macOS keeps under ~/Library. Their roots are refused; a folder inside one is work. */
const CLOUD_ROOTS = ['library/cloudstorage', 'library/mobile documents']

/**
 * Why this folder can't be the working folder, in words, or '' when it can.
 *
 * `path` must be the REAL path (links followed): main resolves it before asking, because
 * Prometheus resolves it too, and a link named "notes" that leads to the home folder is the home
 * folder. `home` is this computer's real home folder.
 *
 * Refused: the disk; any top-level folder itself; a system folder and everything in it; a whole
 * mounted disk or a whole person's folder (this person's home included); and, at the top of home,
 * the hidden folders and Library, which hold keys and every app's settings, except a folder inside
 * a cloud-storage root.
 */
export function folderProblem(path: string, home: string | null | undefined): string {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'That is not a folder Beacon can use.'
  if (path !== path.trim()) return 'That folder\'s name starts or ends with a space, which Prometheus would drop. Rename it, or choose another.'
  const p = clean(path)
  const parts = p.split('/').slice(1)
  if (p === '/') return 'That is the whole disk. Choose one folder to work in.'
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'That is not a plain path to a folder.'
  const h = home ? clean(home) : ''
  const lower = p.toLowerCase()
  const inHome = h !== '' && p.startsWith(`${h}/`)
  if (h && p === h) return 'That is your whole home folder. Choose one folder inside it to work in.'
  if (h && h.startsWith(`${p}/`)) return 'That folder contains your home folder. Choose one folder inside your home folder.'
  if (inHome) {
    const rel = p.slice(h.length + 1)
    const relLower = rel.toLowerCase()
    const top = rel.split('/')[0]
    if (top.startsWith('.')) return `"${top}" holds settings and keys. Choose a folder with your work in it.`
    if (top.toLowerCase() === 'library') {
      // ~/Library/CloudStorage/<provider>/<folder…> and ~/Library/Mobile Documents/<app>/<folder…>
      const cloud = CLOUD_ROOTS.find((c) => relLower.startsWith(`${c}/`))
      const below = cloud ? rel.slice(cloud.length + 1).split('/').length : 0
      if (below >= 2) return ''
      return cloud ? 'That is a whole cloud-storage folder. Choose one folder inside it.' : "The Library folder holds every app's settings. Choose a folder with your work in it."
    }
    return ''
  }
  if (SYSTEM_DIRS.some((d) => lower === d || lower.startsWith(`${d}/`))) return 'That is a system folder. Choose a folder of your own to work in.'
  const mount = MOUNT_DIRS.find((d) => lower === d || lower.startsWith(`${d}/`))
  if (mount) {
    if (parts.length <= 2) return mount === '/users' || mount === '/home' ? "That is a whole person's folder, or the folder that holds them. Choose one folder of your own." : 'That is a whole disk. Choose one folder on it.'
    // Another person's home on this computer. (/Users/Shared is the one that is everybody's.)
    if ((mount === '/users' || mount === '/home') && parts[1].toLowerCase() !== 'shared') return "That is in another person's folder. Choose a folder of your own."
    return ''
  }
  if (parts.length === 1) return 'That is a top-level folder of the disk. Choose one folder inside it.'
  return ''
}

/** What the chip in a conversation's header says. */
export interface FolderChip {
  /** 'bound': working in a folder. 'none': no folder. 'unknown': Beacon could not check just now
   *  (and says so, rather than showing a guess or nothing). 'hidden': there is nothing to check:
   *  this Prometheus has no such thing, or has not been asked yet. */
  state: 'bound' | 'none' | 'unknown' | 'hidden'
  text: string
  /** The full line for the tooltip and the screen reader. */
  title: string
  /** The folder's path, when bound. */
  path: string | null
}

/** What the last read of a conversation's folder came to. */
export type FolderRead =
  | { kind: 'asking' } // not answered yet
  | { kind: 'absent' } // this Prometheus has no such route, or this Beacon may not read it
  | { kind: 'failed'; last: SessionWorkspaceDTO | null } // could not be read just now; `last` is what was known before
  | { kind: 'ok'; ws: SessionWorkspaceDTO }

/** A read's failure, sorted: a 404 (no such route), or a 401/403 (not this Beacon's to read), means
 *  there is nothing to show; anything else is "could not check just now". */
export function readFailureKind(message: string): 'absent' | 'failed' {
  const status = /^HTTP (\d{3})\b/.exec((message ?? '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''))?.[1]
  return status === '404' || status === '401' || status === '403' ? 'absent' : 'failed'
}

const boundPath = (ws: SessionWorkspaceDTO | null | undefined): string | null => {
  if (!ws || typeof ws !== 'object' || ws.source !== 'session') return null
  const b = ws.workspace ?? ws.path ?? ws.cwd
  return typeof b === 'string' && b.trim() ? clean(b) : null
}

/** `where` is the other computer's name, or '' when it has none worth showing. */
export function folderChip(read: FolderRead, home: string | null | undefined, here: boolean, where: string): FolderChip {
  if (read.kind === 'asking' || read.kind === 'absent') return { state: 'hidden', text: '', title: '', path: null }
  const ws = read.kind === 'ok' ? read.ws : read.last
  // An answer that is not the shape Prometheus gives is not "no folder": nothing true can be said.
  if (read.kind === 'ok' && (!ws || typeof ws !== 'object' || Array.isArray(ws) || typeof ws.source !== 'string')) return { state: 'hidden', text: '', title: '', path: null }
  const place = here ? 'on this computer' : where ? `on ${where}` : 'on the Prometheus computer'
  const path = boundPath(ws)
  if (read.kind === 'failed') {
    const was = path ? ` It was last working in ${here ? folderDisplay(path, home) : path}, ${place}.` : ''
    return { state: 'unknown', text: path ? `${folderName(path)}?` : 'Folder?', title: `Beacon could not check which folder this conversation is working in just now.${was}`, path }
  }
  if (!path) return { state: 'none', text: 'No folder', title: 'This conversation is not working in a folder of yours.', path: null }
  return { state: 'bound', text: folderName(path), title: `Your assistant is working in ${here ? folderDisplay(path, home) : path}, ${place}.`, path }
}

/** What is asked before a folder is set: everything setting it does, as Prometheus does it. */
export function folderConfirm(path: string, home: string | null | undefined): { title: string; body: string; does: string[]; after: string; action: string } {
  return {
    title: `Let your assistant work in ${folderDisplay(path, home)}?`,
    body: 'In this conversation, from its next reply, your assistant will:',
    does: [
      'change and delete files in this folder without asking you each time',
      'run commands there',
      'follow instruction files it finds there (PROMETHEUS.md, CLAUDE.md, AGENTS.md), so only choose a folder whose contents you trust',
      'keep a copy of the folder\'s files each turn, so a change can be undone'
    ],
    after: 'This becomes the one place this conversation writes without asking. Nothing outside the folder is opened to it by this, and no other conversation is changed.',
    action: 'Use this folder'
  }
}

/** After a set that Prometheus answered. `confirmed` is the real path the person said yes to;
 *  `resolved` is the folder Prometheus says it bound. They must be the same folder: if they are
 *  not, the person did not agree to what was set, and the caller takes it back (`ok: false`). */
export function folderSetWords(confirmed: string, resolved: string | null | undefined, home: string | null | undefined): { ok: boolean; mismatch: boolean; words: string } {
  const r = typeof resolved === 'string' ? resolved.trim() : ''
  if (!r) return { ok: false, mismatch: false, words: 'Prometheus did not set the folder. Nothing has changed.' }
  if (clean(r) !== clean(confirmed)) {
    return { ok: false, mismatch: true, words: `Prometheus took that to mean a different folder (${folderDisplay(r, home)}), which is not the one you agreed to, so Beacon has taken it back. This conversation has no folder.` }
  }
  return {
    ok: true,
    mismatch: false,
    words: `Your assistant now works in ${folderDisplay(r, home)}, from its next reply. If it says it cannot open the folder, your computer may need to allow Prometheus to use it: on a Mac, System Settings → Privacy & Security → Files and Folders.`
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

/** The other computer's name as the chip may use it. The connection's display name is "Local" for
 *  any private address, which would read as THIS computer for a Prometheus that is not on it; that
 *  one is dropped, and the chip then says "the Prometheus computer". */
export function otherComputerName(display: string | null | undefined): string {
  const d = (display ?? '').trim()
  return d.toLowerCase() === 'local' ? '' : d
}

/** What the popover says when the picker is not offered. */
export function elsewhereWords(where: string, verdict: FolderWhere['verdict'] = 'elsewhere'): string {
  const how = "To set one, type /workspace and the folder's path there as a message in this conversation."
  if (verdict === 'tunnel') return `Beacon reaches Prometheus through this computer, but the two do not share its folders (a tunnel, a container or a virtual machine), so the folder is one on Prometheus's side and Beacon cannot show you those. ${how}`
  if (verdict === 'unknown') return `Beacon could not check that Prometheus shares this computer's folders, so it will not offer to pick one here. ${how}`
  return `Prometheus runs on ${where || 'another computer'}, so the folder is one on that computer, and Beacon cannot show you its folders from here. ${how}`
}

/** The picker's answer (main → the page). `path` is the REAL path of what was chosen, already
 *  through `folderProblem` in main. */
export type FolderPick = { kind: 'picked'; path: string } | { kind: 'refused'; words: string } | { kind: 'cancelled' } | { kind: 'not-here' }

/** Where Prometheus is (main → the page). `here` is true only when a shared disk was proved. */
export interface FolderWhere {
  here: boolean
  /** 'here' proved; 'elsewhere' not loopback; 'tunnel' loopback but no shared disk; 'unknown' could not be checked. */
  verdict: 'here' | 'elsewhere' | 'tunnel' | 'unknown'
  /** This computer's real home folder, for showing paths. */
  home: string
}
