// Files handed to Beacon by the system: "Open with Beacon", a file dropped on Beacon's icon, a
// file path on the command line. Pure rules (no DOM, no Electron, no fs), shared by main, the
// confirmation screen and the headless smoke.
//
// THE RULE EVERYTHING HERE SERVES: nothing that arrives from outside Beacon does anything until
// the person has seen it and said yes. A file handed over this way was not picked inside Beacon.
// Another app, a script or a web page's download prompt can hand one over as easily as Finder
// can. So an offer is only a list: main names the files (name and size) and reads NOTHING. The
// confirmation screen shows that list. On yes, and only then, main reads the bytes and they are
// staged in a message box as attachments, exactly as if they had been picked with the paperclip.
// They are not sent. The person sends, or doesn't.
//
// What an offer can never be: a folder, an application, anything executable-by-opening. Beacon
// only ever READS an offered file as an attachment; it never opens, runs or previews it.

import { CHAT_UPLOAD_SAFE_BYTES } from './attachments'

/** The most files one offer carries. More than this is not "attach these", and the rest are named as left out. */
export const OFFER_MAX_FILES = 10
/** The most one offer may add in all. Each file is read whole and held in memory more than once. */
export const OFFER_MAX_TOTAL_BYTES = 40 * 1024 * 1024
/** The most paths main keeps for one offer before it stops listening (a loop handing over files). */
export const OFFER_MAX_PATHS = 50
/** The most offers that wait behind the one on screen. */
export const OFFER_MAX_QUEUE = 4
/** How long paths that arrive together are gathered into one offer BEFORE it is shown. Once an
 *  offer is on screen its list never changes; whatever comes later is another offer, after this one. */
export const OFFER_GATHER_MS = 400
/** How long the confirmation's "add" buttons stay unarmed after the screen comes up or the window
 *  gains focus: long enough that a click or key already on its way lands on nothing. */
export const OFFER_ARM_MS = 1200
/** How long the helper process gets to look at one batch of offered paths. Looking is an lstat
 *  and a walk up the parents: milliseconds on a disk that answers. Past this the disk is not
 *  answering, the helper is ended, and what it did not get to is shown as not looked at. */
export const OFFER_LOOK_MS = 5000
/** How long the helper gets to read ONE file after a yes. */
export const OFFER_READ_MS = 20000

/** What main learned about one path, without reading the file. */
export interface OfferStat {
  /** The path as it was handed over. */
  path: string
  /** Where it really is (every link in the path followed), or '' when that cannot be found. */
  real: string
  /**
   * 'file' a regular file. 'link' the path itself is a link to something else. 'directory',
   * 'other' (a device, a pipe, a socket), 'missing'. 'slow': the disk it is on did not answer in
   * time, so nothing is known about it. Only 'file' can be added.
   */
  kind: 'file' | 'link' | 'directory' | 'other' | 'missing' | 'slow'
  size: number
  /**
   * Where the file is in relation to the two folders that matter, found by main by IDENTITY (the
   * folder's device and inode among the file's parents), not by comparing spellings: a path can
   * reach the same folder in another letter case, another Unicode form, or by another route
   * (/System/Volumes/Data/Users/…), and a spelling compare misses all three.
   */
  inProfile: boolean
  /** The path below the home folder, when the file is inside it; null when it is not. */
  homeRel: string | null
  /** Which file this is (device:inode), so a yes reads the SAME file that was offered. */
  ident: string
}

/** One file as the confirmation screen shows it. */
export interface OfferedFile {
  /** The name, made safe to show and to send (`safeName`). The same string is used for both. */
  name: string
  /** The folder it is in, with the home folder as `~`. */
  folder: string
  /** What kind of file the name says it is, in words. */
  kind: string
  size: number
  /** '' when the file can be added; otherwise why it will not be, in words. */
  problem: string
}

/** An offer waiting for an answer. `id` names it for the answer; it is minted by main and is never
 *  a path, so the page can say yes only to an offer main made. */
export interface FileOffer {
  id: string
  files: OfferedFile[]
  /** Files offered beyond OFFER_MAX_FILES, which are not in the list. */
  leftOut: number
  /** Offers waiting behind this one. */
  waiting: number
}

/** The last part of a path. Split on `/`; on `\\` only for a drive-letter path, because on this
 *  kind of disk a backslash is an ordinary character in a name (`.env\\holiday.jpg` is one file). */
const lastPart = (p: string): string => {
  const win = /^[A-Za-z]:[\\/]/.test(p)
  const t = p.replace(win ? /[\\/]+$/ : /\/+$/, '')
  return t.slice((win ? Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) : t.lastIndexOf('/')) + 1) || t
}
const parentOf = (p: string): string => {
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i <= 0 ? '/' : t.slice(0, i)
}

// Characters that are part of a name's bytes and not of what a person reads: controls, every
// "format" character (direction overrides and isolates, zero-width characters, soft hyphens, the
// invisible TAG characters that can spell a whole hidden sentence), unassigned and private-use
// code points, lone surrogates, variation selectors, and the blank "letters" some scripts have.
// What is shown must be what is sent, so all of them are removed before either.
const UNSAFE_NAME_CHARS = /[\p{Default_Ignorable_Code_Point}\ufffc\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u034f\u115f\u1160\u3164\uffa0\u2800\u2028\u2029\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu
const NAME_MAX = 80

/**
 * A file's name as Beacon shows it AND sends it: one string for both, so what the person reads is
 * what the assistant is told. Characters that are not part of what is read are removed, runs of
 * spaces are one space, and a long name is cut in the MIDDLE (by whole characters), so its
 * beginning and its extension are both in view.
 */
export function safeName(raw: string): string {
  const cleaned = lastPart(raw).normalize('NFC').replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'unnamed file'
  const chars = Array.from(cleaned)
  if (chars.length <= NAME_MAX) return cleaned
  return `${chars.slice(0, NAME_MAX - 25).join('')}…${chars.slice(-24).join('')}`
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`

/** Folders under ~/Library a person keeps work in (cloud drives). Everything else there is apps'
 *  data: keychains, cookies, mail, messages, every app's settings. */
const LIBRARY_WORK = ['mobile documents', 'cloudstorage']
const fold = (x: string): string => x.normalize('NFC').toLowerCase()

/** What is said after a refusal for where a file is: the way that still works. A file a person
 *  picks inside Beacon is their own choice; these rules are only about files handed over. */
const PAPERCLIP = 'To attach it anyway, use the paperclip in the message box.'

/** The top folders of the startup disk that hold the system and its settings, not a person's work. */
const SYSTEM_TOP = new Set(['etc', 'private', 'var', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'system', 'library', 'boot', 'root', 'proc', 'sys', 'dev', 'run', 'cores'])

/** Whether folded parts, counted from the top of a disk, are inside a system folder. Temporary
 *  folders are not (apps hand over files from there all the time), nor are the places Linux
 *  shows a person's own files through (/run/user/<n>/doc, /run/user/<n>/gvfs).
 *  On ANOTHER disk only the unmistakable ones count: a memory stick may well have a "Library", a
 *  "bin", a "System" or a "Private" of its owner's making. */
function inSystemFolder(f: readonly string[], elsewhere: boolean): boolean {
  if (f.length < 2) return false
  const temp = (at: number): boolean => f.length > at + 1 && (f[at] === 'tmp' || f[at] === 'folders')
  const p = f[0] === 'private' ? 1 : 0
  if (f.length > p + 1 && f[p] === 'etc') return true
  if (f.length > p + 1 && f[p] === 'var') return !temp(p + 1)
  if (elsewhere) return f.length > 2 && f[0] === 'system' && f[1] === 'library'
  if (!SYSTEM_TOP.has(f[0])) return false
  if (f[0] === 'private') return !(f[1] === 'tmp' && f.length > 2)
  if (f[0] === 'run') return !(f[1] === 'user' && f.length > 4 && (f[3] === 'doc' || f[3] === 'gvfs'))
  if (f[0] === 'dev') return !(f[1] === 'shm' && f.length > 2)
  return true
}

/** Whether folded parts hold some person's app data, at ANY depth (a backup keeps whole home
 *  folders far below the top of its disk): a Library apart from its cloud drives, or the folder
 *  Linux "snap" apps keep theirs in (a browser installed that way has its whole profile there,
 *  with no dot anywhere in the path). Returns where the folder's name is, or -1. */
function appDataAt(f: readonly string[]): number {
  for (let i = 0; i + 3 < f.length; i++) {
    if (f[i] !== 'users' && f[i] !== 'home') continue
    if (f[i + 2] === 'library' && !(f.length >= i + 6 && LIBRARY_WORK.includes(f[i + 3]))) return i + 2
    if (f[i + 2] === 'snap') return i + 2
  }
  return -1
}

/**
 * Why the place a file REALLY is makes it one Beacon will not take from outside, when nothing in
 * the path starts with a dot: `{ where, what }` for the words, or null. Read from the real path's
 * own parts, case and Unicode form folded. `inHome`: main found the file inside the home folder
 * (by identity); then it is not in a system folder wherever that home is (on some Linux systems
 * home is /var/home/<name>), though it can still be in app data.
 * The parts that only say WHICH disk are stepped over first, so the same folder is judged the
 * same by any route to it: /System/Volumes/Data/… is the startup disk by another name, and
 * /Volumes/<name>/…, /mnt/…, /media/… and /run/media/… are other disks, where another computer's
 * system sits just the same.
 */
export function sensitivePlace(real: string, inHome = false): { where: string; what: 'system' | 'library' | 'snap' } | null {
  const parts = real.split('/').filter(Boolean)
  const f = parts.map(fold)
  const data = appDataAt(f)
  if (data >= 0) return { where: parts[data], what: f[data] === 'library' ? 'library' : 'snap' }
  if (inHome) return null
  // Each way the leading parts may be read: [how many parts name the disk, is it another disk].
  // When they do name a disk, they are not read as folders of the startup disk as well:
  // /System/Volumes/Data/Users/… is a person's home, not something inside /System.
  let reads: [number, boolean][] = [[0, false]]
  if (f[0] === 'system' && f[1] === 'volumes' && f[2] === 'data') reads = [[3, false]]
  else if (f[0] === 'volumes') reads = [[2, true]]
  else if (f[0] === 'mnt') reads = [[1, true], [2, true]] // a disk at /mnt itself, and /mnt/<disk>
  else if (f[0] === 'media') reads = [[2, true], [3, true]] // /media/<disk> and /media/<person>/<disk>
  else if (f[0] === 'run' && f[1] === 'media') reads = [[4, true]]
  for (const [skip, elsewhere] of reads) {
    const rest = f.slice(skip)
    if (inSystemFolder(rest, elsewhere)) {
      const two = rest[0] === 'private' && rest.length > 2
      return { where: `/${parts.slice(skip, skip + (two ? 2 : 1)).join('/')}`, what: 'system' }
    }
  }
  return null
}

/**
 * Why one offered path will not be added, or ''. The location rules read the facts main found by
 * identity (`inProfile`, `homeRel`) and the REAL path's own parts, never the spelling it was
 * handed over by. They are about where a file is, not who asked: Beacon's own files, hidden files
 * and anything inside a hidden folder (at any depth, on any disk), the insides of an application,
 * and a person's Library apart from its cloud drives.
 */
export function offerProblem(s: OfferStat): string {
  // A link shows one name and reads another file. Beacon adds the file a person can see.
  if (s.kind === 'link') return 'This is a link to another file. Beacon adds a file itself, not a link to one.'
  if (s.kind === 'slow') return 'The disk this file is on did not answer, so Beacon could not look at it. Try again when the disk is back.'
  if (s.kind === 'missing' || !s.real) return 'Beacon cannot find this file any more.'
  if (s.kind === 'directory') return /\.app\/?$/i.test(s.path) ? 'This is an application, not a file.' : 'This is a folder. Beacon adds files, one by one.'
  if (s.kind !== 'file') return 'This is not an ordinary file.'
  if (s.inProfile) return "This is one of Beacon's own files. It is not added to messages."
  const parts = s.real.split('/').filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  if (name.startsWith('.')) return 'This is a hidden file, the kind that holds settings or keys. Beacon does not add those.'
  const hidden = parts.slice(0, -1).find((c) => c.startsWith('.'))
  if (hidden) return `This file is inside "${safeName(hidden)}", a hidden folder, the kind that holds settings or keys. Beacon does not add files from there.`
  if (parts.slice(0, -1).some((c) => /\.app$/i.test(c))) return 'This file is inside an application. Beacon does not add those.'
  if (s.homeRel !== null) {
    const rel = s.homeRel.split('/').filter(Boolean).map(fold)
    if (rel[0] === 'library' && !(rel.length >= 4 && LIBRARY_WORK.includes(rel[1]))) return "This file is in your Library, where apps keep their own data. Beacon does not add files from there."
    if (rel[0] === 'snap' && rel.length >= 2) return `This file is in "snap", where apps keep their own data. Beacon does not take files from there when they are handed over. ${PAPERCLIP}`
  }
  // No dot anywhere, and still not a person's work: a system folder, someone's Library on any
  // disk, an app's data folder. Refused here only; the paperclip is the person's own choice.
  const place = sensitivePlace(s.real, s.homeRel !== null)
  if (place) {
    const where = safeName(place.where).replace(/"/g, '')
    if (place.what === 'system') return `This file is in "${place.where.startsWith('/') ? '/' : ''}${where}", a system folder. Beacon does not take files from there when they are handed over. ${PAPERCLIP}`
    return `This file is in ${place.what === 'library' ? 'a Library' : `"${where}"`}, where apps keep their own data. Beacon does not take files from there when they are handed over. ${PAPERCLIP}`
  }
  if (s.size > CHAT_UPLOAD_SAFE_BYTES) return `This file is ${mb(s.size)}, more than the ${Math.round(CHAT_UPLOAD_SAFE_BYTES / (1024 * 1024))} MB Prometheus accepts.`
  if (s.size === 0) return 'This file is empty.'
  return ''
}

/** The stats an offer is built from: each real file once, in the order they came. */
function unique(stats: readonly OfferStat[]): OfferStat[] {
  const seen = new Set<string>()
  return stats.filter((s) => {
    const k = s.real || s.path
    return seen.has(k) ? false : (seen.add(k), true)
  })
}

/** Each shown stat with its verdict, the running total applied: once the files that can be added
 *  reach OFFER_MAX_TOTAL_BYTES, the ones after are left for another time and say so. */
function judged(stats: readonly OfferStat[]): { stat: OfferStat; problem: string }[] {
  let total = 0
  return unique(stats)
    .slice(0, OFFER_MAX_FILES)
    .map((stat) => {
      let problem = offerProblem(stat)
      if (!problem) {
        if (total + stat.size > OFFER_MAX_TOTAL_BYTES) problem = `Together these are more than ${Math.round(OFFER_MAX_TOTAL_BYTES / (1024 * 1024))} MB. Add this one separately.`
        else total += stat.size
      }
      return { stat, problem }
    })
}

/** The folder a file is in, as shown: below the home folder as `~/…` when main found it there
 *  (by identity, whatever spelling reached it), its real folder otherwise. */
function folderShown(stat: OfferStat): string {
  if (stat.homeRel === null) return parentOf(stat.real || stat.path)
  const dir = stat.homeRel.split('/').filter(Boolean).slice(0, -1).join('/')
  return dir ? `~/${dir}` : '~'
}

/** The offer for a set of stat'ed paths, as the page is shown it: names, folders and sizes. Never
 *  a full path to read, and never anything read from a file. */
export function buildOffer(id: string, stats: readonly OfferStat[], waiting = 0): FileOffer {
  const all = unique(stats)
  const files = judged(stats).map(({ stat, problem }) => ({
    name: safeName(stat.real || stat.path),
    folder: folderShown(stat).replace(UNSAFE_NAME_CHARS, ''),
    kind: kindForName(safeName(stat.real || stat.path)),
    size: stat.size,
    problem
  }))
  return { id, files, leftOut: all.length - files.length, waiting }
}

/** The files of an offer that may be read on yes, in the order shown: where each really is, and
 *  the name it goes by. */
export function acceptableFiles(stats: readonly OfferStat[]): { real: string; name: string; size: number; ident: string }[] {
  return judged(stats)
    .filter((j) => j.problem === '')
    .map((j) => ({ real: j.stat.real, name: safeName(j.stat.real), size: j.stat.size, ident: j.stat.ident }))
}

export const offerAcceptable = (o: FileOffer): number => o.files.filter((f) => !f.problem).length

/**
 * The file paths in a command line, for platforms that deliver "open with" that way (Linux,
 * Windows, and a second launch anywhere). Only what can be a file the person chose: an absolute
 * path, or a file:// address (what Linux file managers pass), that is not a flag. argv[0] is the
 * program itself and is skipped; so is the word after a flag that takes its value separately,
 * and everything is taken as a file after a bare `--`. Whether a path IS a regular file is main's
 * to check (a directory, such as the app's own folder in a development run, drops out there).
 */
export function filePathsInArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  let onlyFiles = false
  let skipNext = false
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string' || !a) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!onlyFiles && a === '--') {
      onlyFiles = true
      continue
    }
    if (!onlyFiles && a.startsWith('-')) {
      // `-r /abs/hook.js`, `--require /abs/x.js`: the next word is the flag's, not a file handed over.
      if (!a.includes('=')) skipNext = /^(-r|--require|--import|--loader|--inspect-brk-node|--app|--user-data-dir|--profile-directory)$/.test(a)
      continue
    }
    if (/^file:\/\//i.test(a)) {
      try {
        const u = new URL(a)
        if ((u.hostname === '' || u.hostname === 'localhost') && u.pathname.startsWith('/')) out.push(decodeURIComponent(u.pathname))
      } catch {
        /* not an address: not a file */
      }
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) continue // a link of any other scheme is never a file path
    if (a.startsWith('/') || /^[A-Za-z]:[\\/]/.test(a)) out.push(a)
  }
  return out
}

/** The words on the confirmation screen. `conversation` is the open conversation's name, or null. */
export function offerWords(o: FileOffer, conversation: string | null): { title: string; body: string; mode: string; note: string; primary: string; secondary: string | null } {
  const n = offerAcceptable(o)
  const total = o.files.length
  const files = n === 1 ? 'this file' : `these ${n} files`
  const more = o.waiting > 0 ? `${o.waiting === 1 ? 'One more set of files is' : `${o.waiting} more sets of files are`} waiting after this one.` : ''
  const left = o.leftOut > 0 ? `${o.leftOut} more ${o.leftOut === 1 ? 'file was' : 'files were'} handed over and left out: Beacon adds ${OFFER_MAX_FILES} at a time.` : ''
  return {
    title: n === 0 ? (total === 1 ? 'This file cannot be added' : 'None of these files can be added') : `Add ${files} to a message?`,
    body:
      n === 0
        ? 'Something outside Beacon handed it over, and Beacon has not opened or read it.'
        : `${total === 1 ? 'This file was' : 'These files were'} handed to Beacon from outside it (Open with, or dropped on its icon). Beacon has not opened or read ${total === 1 ? 'it' : 'them'}. If you did not just do that yourself, choose Don’t add. Adding takes a click with the mouse or trackpad; a key press cannot add files that came from outside Beacon.`,
    mode: n === 0 ? '' : `If you add ${n === 1 ? 'it' : 'them'}, ${n === 1 ? 'it goes' : 'they go'} into the message box as ${n === 1 ? 'an attachment' : 'attachments'}, and the conversation is set to Agent, the mode attachments are sent in (your assistant can use its tools there). Nothing is sent until you send it.`,
    note: [left, more].filter(Boolean).join(' '),
    primary: 'Add to a new conversation',
    secondary: conversation !== null ? `Add to “${conversation.trim().slice(0, 40) || 'this conversation'}”` : null
  }
}

/** The target of confirmed files that go to the new-chat screen (never a session id). */
export const HOME_TARGET = '\u0000home'

/** The least time main lets pass between showing an offer and taking a yes for it, whatever the
 *  page says: nobody reads a list and clicks in less. */
export const OFFER_MIN_SHOWN_MS = 700

/** After a yes: what to say about files that could not be read after all, or ''. */
export function failedWords(failed: readonly string[]): string {
  if (failed.length === 0) return ''
  return `${failed.length === 1 ? `"${failed[0]}" was` : `${failed.length} files were`} not added: ${failed.length === 1 ? 'it' : 'they'} changed or could not be read after you were shown the list.`
}

/** Whether a click on an "add" button counts as the person's yes. It must be a real pointer click
 *  (`detail` is 0 when a key activated the button, or when code called click()), on a screen that
 *  has been up, with the window in front, for long enough to have been looked at. */
export function clickIsAYes(e: { detail: number; isTrusted: boolean }, armedAt: number, now: number): boolean {
  return e.isTrusted && e.detail >= 1 && now >= armedAt
}

/** A file's bytes, after yes (main → the page). */
export interface TakenFile {
  name: string
  mimeType: string
  base64: string
  size: number
}

/** The answer to taking an offer: the files, or why none (the offer was already answered or replaced). */
export type OfferTake = { ok: true; files: TakenFile[]; failed: string[] } | { ok: false; error: string }

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

/** The type sent with an attachment, from the name alone (the file is not sniffed). */
export function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return (name.includes('.') && MIME[ext]) || 'application/octet-stream'
}

const KIND: Record<string, string> = { png: 'picture', jpg: 'picture', jpeg: 'picture', gif: 'picture', webp: 'picture', pdf: 'PDF', txt: 'text', md: 'text', csv: 'table', json: 'data', docx: 'document', xlsx: 'spreadsheet' }

/** What the name says the file is, in a word: so `invoice.pdf.exe` reads as "exe file", not as a PDF. */
export function kindForName(name: string): string {
  if (!name.includes('.') || name.endsWith('.')) return 'file'
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
  return KIND[ext] ?? (ext ? `${ext.slice(0, 8)} file` : 'file')
}

/** The kinds of file Beacon offers itself for in the system's "Open with" list (never as the
 *  default: see electron-builder.yml). The same list the type table above knows. */
export const OPEN_WITH_EXTENSIONS: readonly string[] = Object.keys(MIME)
