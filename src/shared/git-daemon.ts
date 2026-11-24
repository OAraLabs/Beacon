import type { GitOperation, GitRead, GitState } from './git-state'
import type { GitPr, GitPrRead } from './git-pr'

// Git state as a Prometheus that advertises `git/1` reports it (Prometheus 0.9.22):
//   GET /api/sessions/{id}/git       the answer, below
//   frame workspace_git_changed      { session_id, read_at }: "read again", no state in it
// Pure: nothing here talks to anything. The answer is a daemon's, so every field is checked
// before it is believed, and anything off reads as "could not be read", never as "clean".

export const GIT_DAEMON_CAPABILITY = 'git/1'
export const GIT_CHANGED_FRAME = 'workspace_git_changed'

/** Whether a `subscribed` reply's payload lists git/1. Anything malformed is "no". */
export function advertisesGitStatus(subscribedPayload: unknown): boolean {
  const caps = (subscribedPayload as { server_capabilities?: unknown } | null | undefined)?.server_capabilities
  return Array.isArray(caps) && caps.includes(GIT_DAEMON_CAPABILITY)
}

/** The route for one conversation. Null when the id could not safely be part of a path. */
export function gitDaemonPath(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) return null
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/git`
  return path.includes('..') ? null : path
}

/** The conversation a `workspace_git_changed` frame is about, or null for anything else. */
export function changedFrameSession(ev: { type?: unknown; payload?: unknown } | null | undefined): string | null {
  if (!ev || ev.type !== GIT_CHANGED_FRAME) return null
  const id = (ev.payload as { session_id?: unknown } | null | undefined)?.session_id
  return typeof id === 'string' && id !== '' && id.length <= 200 ? id : null
}

/** With a Prometheus that sends `workspace_git_changed`, a reading is taken again only as a safety net between frames. */
export const GIT_DAEMON_ROW_FRESH_MS = 5 * 60_000
export const GIT_DAEMON_OPEN_FRESH_MS = 60_000

export const GIT_REMOTE_FILES_NOTE = 'Prometheus is on another computer, so the changed files and their changes are not shown here. The counts come from Prometheus.'

export const GIT_UNSAFE_REMOTE = 'Prometheus cannot limit what git may start on its computer, so it does not read git there.'
export const GIT_TOO_BIG = 'This repository has too many changes to read.'
const GIT_TOO_SLOW_REMOTE = 'Git did not answer in time.'
const GIT_NOT_READ_REMOTE = 'Git could not read this folder.'

const WHY: Record<string, string> = {
  unsafe_here: GIT_UNSAFE_REMOTE,
  too_slow: GIT_TOO_SLOW_REMOTE,
  too_big: GIT_TOO_BIG,
  not_read: GIT_NOT_READ_REMOTE
}

const OPERATIONS: ReadonlySet<string> = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])
const COUNT_MAX = 1_000_000
const TEXT_MAX = 1024

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= COUNT_MAX ? v : null
const nullableCount = (v: unknown): number | null | undefined => (v === null ? null : (count(v) ?? undefined))
const nullableText = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' && v.length <= TEXT_MAX ? v : undefined

/** A pull request link as Beacon will open it: https, github.com, owner/repo/pull/number, and the number is the number. */
const PR_URL = /^https:\/\/github\.com\/(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/(?!\.+\/)[A-Za-z0-9_.-]{1,100}\/pull\/(\d{1,9})$/

export function parseDaemonPr(raw: unknown): GitPr | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const number = p.number
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 999_999_999) return null
  if (p.state !== 'open' && p.state !== 'merged' && p.state !== 'closed') return null
  const checks = p.checks
  if (checks !== 'passing' && checks !== 'failing' && checks !== 'pending' && checks !== 'none') return null
  if (typeof p.url !== 'string') return null
  const m = PR_URL.exec(p.url)
  if (!m || Number(m[1]) !== number) return null
  return {
    number,
    state: p.state === 'open' && p.draft === true ? 'draft' : p.state,
    conflicts: p.mergeable === 'conflicting',
    checks,
    url: p.url
  }
}

export interface DaemonGit {
  read: GitRead
  /** The pull request part. A daemon with no `gh`, or no pull request for the branch, sends null: both read as none. */
  pr: GitPrRead
}

/**
 * The answer of GET /api/sessions/{id}/git. Null when it is not that (a wrong version, the wrong
 * shape, a count that is not a count): the caller shows nothing and asks again later.
 */
export function parseDaemonGit(body: unknown): DaemonGit | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.v !== 1) return null
  if (b.kind === 'none') return { read: { kind: 'none' }, pr: { kind: 'none' } }
  if (b.kind === 'unreadable') {
    const why = typeof b.why === 'string' ? WHY[b.why] : undefined
    return { read: { kind: 'unreadable', why: why ?? GIT_NOT_READ_REMOTE }, pr: { kind: 'none' } }
  }
  if (b.kind !== 'state') return null
  const s = b.state as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return null
  const branch = nullableText(s.branch)
  const commit = nullableText(s.commit)
  const upstream = nullableText(s.upstream)
  const ahead = nullableCount(s.ahead)
  const behind = nullableCount(s.behind)
  const staged = count(s.staged)
  const unstaged = count(s.unstaged)
  const untracked = count(s.untracked)
  const conflicted = count(s.conflicted)
  const changed = count(s.changed)
  const op = s.operation
  if (branch === undefined || commit === undefined || upstream === undefined || ahead === undefined || behind === undefined) return null
  if (staged === null || unstaged === null || untracked === null || conflicted === null || changed === null) return null
  if (op !== null && !(typeof op === 'string' && OPERATIONS.has(op))) return null
  // Counts that do not add up are not believed: "nothing changed" over staged files would be a lie.
  if (changed < Math.max(staged, unstaged, untracked, conflicted)) return null
  if (typeof b.top !== 'string' || b.top === '' || b.top.length > TEXT_MAX) return null
  if (typeof b.truncated !== 'boolean') return null
  const state: GitState = {
    branch,
    commit,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    changed,
    operation: op as GitOperation | null
  }
  const pr = parseDaemonPr(b.pr)
  return {
    read: { kind: 'state', state, top: b.top, truncated: b.truncated },
    // A daemon that has no `gh` (or no pull request) sends null. Both read as "none here".
    pr: pr ? { kind: 'pr', pr } : { kind: 'none' }
  }
}
