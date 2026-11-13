// Looking at, and reading, files handed to Beacon by the system (@shared/os-entry). Plain
// synchronous file calls and nothing else: no Electron, no Beacon state.
//
// This runs in a HELPER PROCESS (offer-look-process.ts), never in main. A path handed over from
// outside can be on a disk that has stopped answering (a network share whose server went away),
// and a file call on such a disk does not return. In main that froze every window; through the
// shared pool of file threads it would have starved every other file call main makes. In a
// process of its own it costs only that process, which main ends when it runs out of patience
// (offer-looker.ts). The smoke calls these functions directly.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OfferStat } from '@shared/os-entry'

/** The two folders a file is placed against. */
export interface LookDirs {
  profile: string
  home: string
}

const realOf = (p: string): string => {
  try {
    // The system's own resolution: links followed, and on a Mac the name as the disk spells it.
    return realpathSync.native(p)
  } catch {
    return ''
  }
}
const identOf = (p: string): string | null => {
  try {
    const st = statSync(p)
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

/** Where a file is in relation to Beacon's profile and the home folder, by IDENTITY: its parents
 *  are walked up and compared, device and inode, with those two folders. A spelling compare is
 *  not enough: the same folder is reached in another letter case, another Unicode form, and on a
 *  Mac by another route (/System/Volumes/Data/Users/…). */
function placeOf(real: string, dirs: LookDirs): { inProfile: boolean; homeRel: string | null } {
  const profile = identOf(dirs.profile)
  const home = identOf(dirs.home)
  let inProfile = false
  let homeRel: string | null = null
  let dir = dirname(real)
  // To the top of the disk, however deep the file is (dirname reaches a fixed point there).
  for (let i = 0; i < 4096; i++) {
    const id = identOf(dir)
    if (id && id === profile) inProfile = true
    if (id && id === home && homeRel === null) homeRel = real.slice(dir.length).replace(/^\/+/, '')
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { inProfile, homeRel }
}

/** One path, looked at without being read. lstat, so a link is seen as a link (it is refused:
 *  it shows one name and would read another file). */
export function lookAt(path: string, dirs: LookDirs): OfferStat {
  const nowhere = { inProfile: false, homeRel: null, ident: '' }
  try {
    const st = lstatSync(path)
    const kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other'
    if (kind === 'link') return { path, real: '', kind, size: 0, ...nowhere }
    if (kind !== 'file') {
      // Not addable, but shown: placed the same way, so its folder reads as ~/… like the others.
      const where = realOf(path)
      return { path, real: where, kind, size: 0, ...nowhere, ...(where ? { homeRel: placeOf(where, dirs).homeRel } : {}) }
    }
    const real = realOf(path)
    if (!real) return { path, real: '', kind: 'missing', size: 0, ...nowhere }
    return { path, real, kind, size: st.size, ...placeOf(real, dirs), ident: `${st.dev}:${st.ino}` }
  } catch {
    return { path, real: '', kind: 'missing', size: 0, ...nowhere }
  }
}

/** Read one offered file for a yes: opened ONCE, without following a link and without blocking on
 *  a pipe, then judged and read through that same open file, never by name again. It must be the
 *  SAME file that was offered (device and inode) at the SAME size: one swapped in under the name,
 *  reached through a parent folder that became a link, or grown since, is refused. */
export function readOne(f: { real: string; ident: string; size: number }, max: number): Uint8Array | null {
  let fd: number | null = null
  try {
    fd = openSync(f.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || `${st.dev}:${st.ino}` !== f.ident || st.size !== f.size || st.size === 0 || st.size > max) return null
    const buf = new Uint8Array(st.size)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : null // shorter than it said it was: not the file that was offered
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do about a close that failed */
      }
    }
  }
}

/** What main asks the helper, and what it answers. `n` pairs an answer with its question. */
export type LookAsk =
  | { n: number; ask: 'look'; paths: string[]; dirs: LookDirs }
  | { n: number; ask: 'read'; file: { real: string; ident: string; size: number }; max: number }
export type LookAnswer =
  | { n: number; at: number; stat: OfferStat } // one path looked at, as each is done
  | { n: number; done: true } // every path of a 'look' has been answered
  | { n: number; bytes: Uint8Array | null } // a 'read'

/** Answer one question, posting each part as it is ready. */
export function answer(q: LookAsk, post: (a: LookAnswer) => void): void {
  if (q.ask === 'read') return post({ n: q.n, bytes: readOne(q.file, q.max) })
  // One answer per path, so the paths before one that never returns are not lost with it.
  q.paths.forEach((p, at) => post({ n: q.n, at, stat: lookAt(p, q.dirs) }))
  post({ n: q.n, done: true })
}
