// How a conversation's git state is shown: the mark on its row in the session list, and the
// branch chip in its header. Pure words and choices; the drawing is GitMark / GitChip.
//
// A mark has a SHAPE per kind, so colour is never the only signal:
//   branch   a plain branch glyph: a repository with nothing to say
//   changes  the branch glyph with a count: that many changed files
//   moved    the branch glyph with an arrow: commits ahead of or behind the upstream, no changes
//   alert    a warning glyph: a merge, rebase or the like under way, or files in conflict
import { GIT_MAX_ENTRIES, gitText, type GitDetail, type GitDiffMode, type GitEntry, type GitOperation, type GitRead, type GitState } from './git-state'

export type GitMarkKind = 'branch' | 'changes' | 'moved' | 'alert'

export interface GitMark {
  kind: GitMarkKind
  /** The number beside the glyph (changed files), or '' for none. */
  count: string
  /** One sentence for the tooltip and for a screen reader. */
  words: string
}

const OPERATION_WORDS: Record<GitOperation, string> = {
  merge: 'a merge is under way',
  rebase: 'a rebase is under way',
  'cherry-pick': 'a cherry-pick is under way',
  revert: 'a revert is under way',
  bisect: 'a bisect is under way'
}

const files = (n: number): string => `${n} changed ${n === 1 ? 'file' : 'files'}`

/** The name to show for where HEAD is: the branch, or the commit when detached, or "no commits yet". */
export function gitHead(s: GitState): string {
  if (s.branch) return gitText(s.branch, 40)
  if (s.commit) return `detached at ${s.commit}`
  return 'no commits yet'
}

/** "2 ahead of origin/main", "1 behind origin/main", "2 ahead and 1 behind origin/main"; '' when in
 *  step, or when there is no upstream to compare with. */
export function gitDistance(s: GitState): string {
  if (!s.upstream || s.ahead === null || s.behind === null) return ''
  const up = gitText(s.upstream, 40)
  if (s.ahead > 0 && s.behind > 0) return `${s.ahead} ahead and ${s.behind} behind ${up}`
  if (s.ahead > 0) return `${s.ahead} ahead of ${up}`
  if (s.behind > 0) return `${s.behind} behind ${up}`
  return ''
}

/** The changed-file count as shown: capped where the reader stopped counting. */
export function gitCount(s: GitState, truncated: boolean): string {
  if (s.changed <= 0) return ''
  return truncated ? `${GIT_MAX_ENTRIES}+` : String(s.changed)
}

/** The mark for a row, or null when there is nothing to show (no repository, or not read). */
export function gitMark(read: GitRead | null | undefined): GitMark | null {
  if (!read || read.kind !== 'state') return null
  const s = read.state
  const head = gitHead(s)
  const distance = gitDistance(s)
  const count = gitCount(s, read.truncated)
  const changed = s.changed > 0 ? (read.truncated ? `more than ${GIT_MAX_ENTRIES} changed files` : files(s.changed)) : ''
  if (s.operation || s.conflicted > 0) {
    const why = [s.operation ? OPERATION_WORDS[s.operation] : '', s.conflicted > 0 ? `${s.conflicted} in conflict` : ''].filter(Boolean).join(', ')
    return { kind: 'alert', count, words: [`Git: ${head}`, why, changed, distance].filter(Boolean).join(' · ') }
  }
  if (s.changed > 0) return { kind: 'changes', count, words: [`Git: ${head}`, changed, distance].filter(Boolean).join(' · ') }
  if (distance) return { kind: 'moved', count: '', words: `Git: ${head} · nothing changed · ${distance}` }
  return { kind: 'branch', count: '', words: `Git: ${head} · nothing changed` }
}

export interface GitChipView {
  kind: GitMarkKind
  /** The branch (or where HEAD is), cut for the header. */
  head: string
  count: string
  ahead: number
  behind: number
  words: string
}

/** The header chip, or null when there is nothing to show. */
export function gitChip(read: GitRead | null | undefined): GitChipView | null {
  // A repository that could not be read still has a chip: it is how a person finds out why.
  if (read?.kind === 'unreadable') return { kind: 'alert', head: 'git not read', count: '', ahead: 0, behind: 0, words: `Git: ${read.why}` }
  const mark = gitMark(read)
  if (!mark || !read || read.kind !== 'state') return null
  const s = read.state
  return { kind: mark.kind, head: s.branch ? gitText(s.branch, 28) : s.commit ? `detached ${s.commit}` : 'no commits', count: mark.count, ahead: s.upstream ? (s.ahead ?? 0) : 0, behind: s.upstream ? (s.behind ?? 0) : 0, words: mark.words }
}

/** How long a row's reading is good for, and the open conversation's. */
export const GIT_ROW_FRESH_MS = 55_000
export const GIT_OPEN_FRESH_MS = 9_000

/** Whether a reading taken `age` ms ago should be taken again. */
export function gitStale(age: number, open: boolean): boolean {
  return !(age < (open ? GIT_OPEN_FRESH_MS : GIT_ROW_FRESH_MS))
}

// ── The Git panel ──────────────────────────────────────────────────────────────────────────

const LETTER: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', T: 'type changed', R: 'renamed', C: 'copied', U: 'in conflict' }

export interface GitFileRow {
  /** The path as git wrote it: what a diff is asked for by. */
  path: string
  /** The path as shown. */
  shown: string
  what: string
  /** Which diff this row opens, or null when it has none (an untracked folder). */
  mode: GitDiffMode | null
}

export interface GitGroup {
  title: string
  rows: GitFileRow[]
}

const row = (e: GitEntry, letter: string, mode: GitDiffMode | null): GitFileRow => ({ path: e.path, shown: gitText(e.path, 200), what: LETTER[letter] ?? 'changed', mode })

/** The changed files, grouped as a person thinks of them. A file changed in both the index and
 *  the folder is in both groups: each row opens that side's diff. Empty groups are left out. */
export function gitGroups(entries: readonly GitEntry[]): GitGroup[] {
  const groups: GitGroup[] = [
    { title: 'In conflict', rows: entries.filter((e) => e.kind === 'conflicted').map((e) => ({ ...row(e, 'U', 'unstaged') })) },
    { title: 'Staged', rows: entries.filter((e) => e.kind === 'changed' && e.index !== '.').map((e) => row(e, e.index, 'staged')) },
    { title: 'Not staged', rows: entries.filter((e) => e.kind === 'changed' && e.tree !== '.').map((e) => row(e, e.tree, 'unstaged')) },
    { title: 'Untracked', rows: entries.filter((e) => e.kind === 'untracked').map((e) => ({ path: e.path, shown: gitText(e.path, 200), what: e.path.endsWith('/') ? 'new folder' : 'new file', mode: e.path.endsWith('/') ? null : ('untracked' as const) })) }
  ]
  return groups.filter((g) => g.rows.length > 0)
}

/** The line under the lists when there are more entries than the panel shows. */
export function gitMoreWords(more: number): string {
  return more > 0 ? `${more} more changed ${more === 1 ? 'file is' : 'files are'} not listed.` : ''
}

/** What the panel says when there is nothing to list. */
export function gitEmptyWords(detail: GitDetail): string {
  if (detail.kind === 'unreadable') return detail.why
  if (detail.kind === 'none') return 'This folder is not a git repository any more.'
  return detail.entries.length === 0 ? 'Nothing is changed.' : ''
}
