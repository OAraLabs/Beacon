// The "diff" of a file git does not track yet: the whole file, as added lines. Beacon reads the
// file itself, with checks, because the way to have git do it (`git diff --no-index /dev/null
// <path>`) follows whatever the path has become by the time it runs: review showed a folder on
// the way swapped for a link to somewhere else, and a link to a folder, each printing a file from
// outside the work folder. So: the file must really be inside the repository's top (every link
// in its path resolved), be an ordinary file, be the same file before and after it is opened,
// and be small. A link is shown as a link, never followed.
//
// What these checks cannot rule out: a folder on the way being swapped for a link and back, again
// and again, at exactly the right instants (a review measured a handful of hits in over a hundred
// thousand tries, with a program doing nothing else). The file then shown is one the person's own
// account can read, shown to that person and to nobody else; nothing here returns it to the
// assistant.
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises'
import { GIT_NOT_READ, GIT_TOO_SLOW, clipDiff, gitPathOk, gitText, type GitDiff } from '@shared/git-state'

/** The most of a new file that is read. */
export const UNTRACKED_MAX_BYTES = 1024 * 1024
const TIME_MS = 3000

const added = (path: string, lines: string[]): string => [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n'

async function read(top: string, path: string): Promise<GitDiff> {
  const realTop = await realpath(top)
  const asked = `${top}/${path}`
  const info = await lstat(asked)
  if (info.isSymbolicLink()) return { kind: 'diff', text: added(path, [`(a link to ${gitText(await readlink(asked), 300)})`]), truncated: false }
  if (!info.isFile()) return { kind: 'none' }
  // Where it REALLY is. A folder on the way that is a link takes it outside the top: not shown.
  const real = await realpath(asked)
  if (!real.startsWith(realTop === '/' ? '/' : `${realTop}/`)) return { kind: 'unreadable', why: 'This file is reached through a link to outside this folder, so Beacon does not show it.' }
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = await handle.stat()
    // The same file that was looked at, and still where the path leads: nothing was swapped in between.
    // …and the path, resolved again now, is still inside the top.
    const realAgain = await realpath(asked)
    const again = await stat(realAgain)
    if (!realAgain.startsWith(realTop === '/' ? '/' : `${realTop}/`)) return { kind: 'none' }
    if (!st.isFile() || st.dev !== info.dev || st.ino !== info.ino || again.dev !== st.dev || again.ino !== st.ino) return { kind: 'none' }
    if (st.size > UNTRACKED_MAX_BYTES) return { kind: 'unreadable', why: 'This file is too large to show here.' }
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    const bytes = buf.subarray(0, got)
    if (bytes.subarray(0, 8000).includes(0)) return { kind: 'diff', text: `Binary file, ${got} bytes.\n`, truncated: false }
    const lines = bytes.toString('utf8').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return { kind: 'diff', ...clipDiff(added(path, lines)) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** A new file's content as an all-added diff. `path` is relative to `top` and was just listed by git as untracked. */
export function readUntracked(top: string, path: string): Promise<GitDiff> {
  if (!gitPathOk(path) || !top.startsWith('/')) return Promise.resolve({ kind: 'none' })
  let timer: NodeJS.Timeout | null = null
  const slow = new Promise<GitDiff>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unreadable', why: GIT_TOO_SLOW }), TIME_MS)
  })
  const done = read(top, path).catch((): GitDiff => ({ kind: 'unreadable', why: GIT_NOT_READ }))
  return Promise.race([done, slow]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
