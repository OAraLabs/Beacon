// Runs git, read-only, in a conversation's work folder (@shared/git-state says why this is
// careful, and holds the commands). Each command is a child process with a time limit and a
// process limit of zero: it cannot start another program, and a repository that never answers
// costs a bounded wait, never Beacon's own thread.
import { execFile } from 'node:child_process'
import { readUntracked } from './git-untracked'
import {
  GIT_BORROWED,
  GIT_COMMON_ARGS,
  GIT_DIFF_TOO_BIG,
  GIT_LOG_ARGS,
  GIT_NOT_READ,
  GIT_STATUS_ARGS,
  GIT_TOO_SLOW,
  GIT_UNSAFE_HERE,
  GIT_WHERE_ARGS,
  NO_FORK_SCRIPT,
  NO_FORK_UNSET,
  clipDiff,
  entryHasDiff,
  gitDiffArgs,
  gitOperation,
  gitPathOk,
  gitReadEnv,
  parseGitEntries,
  parseGitLog,
  storeIsOwn,
  storeLinkArgs,
  worktreeNamesBack,
  parseGitStatus,
  parseGitWhere,
  type GitDetail,
  type GitDiff,
  type GitRead
} from '@shared/git-state'

const SH = '/bin/sh'
const TIME_MS = 4000
/** The questions asked once per run (does the limit bind, where is git): a busy computer just
 *  after launch can be slow to start anything, and a wrong "no" here would cost every later read. */
const ONCE_TIME_MS = 20_000
const OUT_MAX = 4 * 1024 * 1024

interface Ran {
  code: number | null
  out: string
  timedOut: boolean
  tooBig: boolean
}

/** One command under the process limit. `argv` are arguments to `sh -c SCRIPT sh …`: data, never script. */
export function run(argv: readonly string[], cwd: string, env: Record<string, string>, script = NO_FORK_SCRIPT, timeMs = TIME_MS): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(SH, ['-c', script, 'sh', ...argv], { cwd, env, timeout: timeMs, killSignal: 'SIGKILL', maxBuffer: OUT_MAX, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        out: typeof stdout === 'string' ? stdout : '',
        timedOut: !!e && (e.killed === true || e.signal === 'SIGKILL') && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        tooBig: !!e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      })
    })
  })
}

/**
 * Whether the process limit really stops a program from being started here. Two runs of the same
 * probe (a shell told to start another shell, then say how that went):
 *   - WITHOUT the limit it must say the inner shell started. That shows the probe itself works
 *     on this computer, so the next answer means something.
 *   - UNDER the limit it must run (a real exit status, in time) and must not say so.
 * Only that pair is "enforced". The answer is kept for the run once it is definite; a probe that
 * could not be run at all (no shell, no processes to spare, too slow) is "no" for now and is
 * asked again next time.
 */
const PROBE = [SH, '-c', `${SH} -c 'exit 0'; echo started:$?`]
let enforced: boolean | null = null
let asking: Promise<boolean> | null = null
export function forkLimitEnforced(env: Record<string, string>): Promise<boolean> {
  if (enforced !== null) return Promise.resolve(enforced)
  asking ??= (async () => {
    const free = await run(PROBE, '/', env, 'exec "$@"', ONCE_TIME_MS)
    if (free.code !== 0 || !/^started:0$/m.test(free.out)) return false // the probe cannot be run here: not known, not kept
    const limited = await run(PROBE, '/', env, NO_FORK_SCRIPT, ONCE_TIME_MS)
    if (limited.timedOut || limited.code === null) return false // did not run: not known, not kept
    enforced = limited.code !== NO_FORK_UNSET && !/started:0/.test(limited.out)
    return enforced
  })().finally(() => {
    asking = null
  })
  return asking
}

/**
 * On a Mac with no developer tools, /usr/bin/git is a stub that puts up an install dialog each
 * time it is run. `xcode-select -p` says whether the tools are there, without a dialog. Asked once.
 */
let stub: Promise<boolean> | null = null
function gitIsAStub(env: Record<string, string>): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false)
  stub ??= run(['/usr/bin/xcode-select', '-p'], '/', env, NO_FORK_SCRIPT, ONCE_TIME_MS).then((r) => r.code !== 0)
  return stub
}

/**
 * The program to run as git. On a Mac with the developer tools, /usr/bin/git is a launcher that
 * finds the real git through `xcrun`, and when xcrun's memory of where things are is cold it
 * starts another program to find out, which the process limit refuses: git then looks absent.
 * So the real git is asked for ONCE, by `xcrun --find git`, run WITHOUT the limit but at the top
 * of the disk with the fixed environment (nothing of the work folder is in play), and that
 * absolute path is what runs under the limit afterwards. Anything unexpected falls back to `git`
 * on the fixed search path.
 */
let program: Promise<string> | null = null
function gitProgram(env: Record<string, string>): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve('git')
  program ??= run(['/usr/bin/xcrun', '--find', 'git'], '/', env, 'exec "$@"', ONCE_TIME_MS).then((r) => {
    const found = r.code === 0 ? r.out.trim() : ''
    return /^\/(Library\/Developer\/CommandLineTools|Applications\/Xcode[^/]*\.app\/Contents\/Developer)\/[A-Za-z0-9_./-]+\/git$/.test(found) && !found.includes('..') ? found : 'git'
  })
  return program
}

/** A folder's last answer is good for this long: a row and a header asking together are one read. */
const FRESH_MS = 1500
/** At most this many folders are being read at once; the rest wait their turn. */
const AT_ONCE = 2
const recent = new Map<string, { at: number; read: GitRead }>()
const inFlight = new Map<string, Promise<GitRead>>()
let running = 0
const waiting: (() => void)[] = []
/** The most reads that may wait their turn. Past it a read is not queued: it is answered "busy". */
const WAITING_MAX = 16
const BUSY = { kind: 'unreadable', why: 'Beacon is already reading git for several conversations. Try again in a moment.' } as const
export async function turn<T>(fn: () => Promise<T>): Promise<T | typeof BUSY> {
  if (running >= AT_ONCE) {
    if (waiting.length >= WAITING_MAX) return BUSY
    await new Promise<void>((r) => waiting.push(r))
  }
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Forget what was read a moment ago (the smoke changes a repository and reads it again at once). */
export function forgetGitReads(): void {
  recent.clear()
}

/** Read git's state for a folder. Reads of the same folder that overlap, or follow within a moment, share one answer. */
export function readGit(
  folder: string,
  baseEnv: Record<string, string | undefined> = process.env,
  /** Whether a repository whose top is this folder may be read. A repository's settings can name
   *  a folder ABOVE the work folder as its work tree; the caller says which tops are acceptable. */
  topAllowed: (top: string) => boolean = () => true
): Promise<GitRead> {
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.includes('\0') || folder.includes('\n')) return Promise.resolve({ kind: 'none' })
  const kept = recent.get(folder)
  if (kept && Date.now() - kept.at < FRESH_MS) return Promise.resolve(kept.read)
  const going = inFlight.get(folder)
  if (going) return going
  const p = turn(() => read(folder, baseEnv, topAllowed))
    .then((r) => {
      recent.set(folder, { at: Date.now(), read: r })
      if (recent.size > 200) recent.delete(recent.keys().next().value as string)
      return r
    })
    .finally(() => inFlight.delete(folder))
  inFlight.set(folder, p)
  return p
}

type Fail = { kind: 'none' } | { kind: 'unreadable'; why: string }
export interface Opened {
  env: Record<string, string>
  git: string
  at: { top: string; gitDir: string; linked: boolean }
}

/** Everything that must hold before any command reads the folder: the limit binds, the real git
 *  is known, and the repository git finds is plainly here with a top the caller accepts. */
export async function open(folder: string, baseEnv: Record<string, string | undefined>, topAllowed: (top: string) => boolean): Promise<Opened | Fail> {
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.includes('\0') || folder.includes('\n')) return { kind: 'none' }
  const probeEnv = gitReadEnv(baseEnv)
  if (!(await forkLimitEnforced(probeEnv))) return { kind: 'unreadable', why: GIT_UNSAFE_HERE }
  const noTools = await gitIsAStub(probeEnv)
  const env = gitReadEnv(baseEnv, { noStub: noTools })
  const git = noTools ? 'git' : await gitProgram(probeEnv)
  const where = await run([git, ...GIT_WHERE_ARGS], folder, env)
  if (where.timedOut) return { kind: 'unreadable', why: GIT_TOO_SLOW }
  if (where.code === NO_FORK_UNSET) return { kind: 'unreadable', why: GIT_UNSAFE_HERE }
  // Not a repository, no git on this computer, a folder that is gone, or a repository whose
  // settings point somewhere else (parseGitWhere): nothing to show.
  const at = where.code === 0 ? parseGitWhere(where.out) : null
  if (!at) return { kind: 'none' }
  // Asked BEFORE status, which is the command that walks the folder: a top the caller will not have
  // (the whole home, a system folder, the disk) is never walked.
  if (!topAllowed(at.top)) return { kind: 'none' }
  // A linked worktree's store must name this folder back (worktreeNamesBack): a `.git` file can
  // point at any repository's worktree store, and that store would then be read as this folder's.
  if (at.linked) {
    const back = await run(['/bin/cat', '--', `${at.gitDir}/gitdir`], '/', env)
    if (back.code !== 0 || !worktreeNamesBack(at.top, at.gitDir, back.out)) return { kind: 'none' }
  }
  return { env, git, at }
}

/** The status output, or why not. */
async function status(o: Opened, folder: string): Promise<string | Fail> {
  const r = await run([o.git, ...GIT_STATUS_ARGS], folder, o.env)
  if (r.timedOut) return { kind: 'unreadable', why: GIT_TOO_SLOW }
  if (r.tooBig) return { kind: 'unreadable', why: 'This repository has more changes than Beacon reads at once.' }
  return r.code === 0 ? r.out : { kind: 'unreadable', why: GIT_NOT_READ }
}

async function read(folder: string, baseEnv: Record<string, string | undefined>, topAllowed: (top: string) => boolean): Promise<GitRead> {
  const o = await open(folder, baseEnv, topAllowed)
  if ('kind' in o) return o
  const out = await status(o, folder)
  if (typeof out !== 'string') return out
  const parsed = parseGitStatus(out)
  if (!parsed) return { kind: 'unreadable', why: GIT_NOT_READ }
  // What is under way: the names in the git folder (MERGE_HEAD, rebase-merge, …). Listed by a
  // child process like the rest, so a stalled disk is a bounded wait here too.
  const names = await run(['/bin/ls', '-1', '--', o.at.gitDir], '/', o.env)
  const { truncated, ...state } = parsed
  return { kind: 'state', state: { ...state, operation: names.code === 0 ? gitOperation(names.out.split('\n')) : null }, top: o.at.top, truncated }
}

/** Whether this repository's index and history are its own (`storeIsOwn` says what that means and
 *  why). Three small reads, each under the limit; any that fails counts as "not its own". */
async function ownStore(o: Opened): Promise<boolean> {
  const common = await run([o.git, ...GIT_COMMON_ARGS], o.at.top, o.env)
  const dir = common.code === 0 ? common.out.trim() : ''
  if (!dir.startsWith('/') || dir.includes('\n')) return false
  const info = await run(['/bin/ls', '-1', '--', `${dir}/objects/info`], '/', o.env)
  // No such folder is fine (nothing is borrowed through it); a folder that could not be listed is not.
  if (info.timedOut || info.tooBig) return false
  const args = storeLinkArgs(o.at.gitDir, dir)
  const top = await run(['/usr/bin/find', ...args.top], '/', o.env)
  const deep = await run(['/usr/bin/find', ...args.deep], '/', o.env)
  if (top.timedOut || top.tooBig || deep.timedOut || deep.tooBig) return false
  return storeIsOwn(o.at.gitDir, dir, info.code === 0 ? info.out.split('\n') : [], top.out.split('\n'), deep.out.split('\n'))
}

/** The changed files and the commits not yet upstream, for the panel. One at a time with the other reads. */
export function readGitDetail(folder: string, baseEnv: Record<string, string | undefined> = process.env, topAllowed: (top: string) => boolean = () => true): Promise<GitDetail> {
  return turn(async (): Promise<GitDetail> => {
    const o = await open(folder, baseEnv, topAllowed)
    if ('kind' in o) return o
    const out = await status(o, folder)
    if (typeof out !== 'string') return out
    const listed = parseGitEntries(out)
    if (!listed) return { kind: 'unreadable', why: GIT_NOT_READ }
    // The file names and commit subjects come from the repository's index and history: only if they are its own.
    if (!(await ownStore(o))) return { kind: 'unreadable', why: GIT_BORROWED }
    // No upstream, or nothing ahead: git says so by failing or by printing nothing. Either is "none".
    const log = await run([o.git, ...GIT_LOG_ARGS], folder, o.env)
    return { kind: 'detail', entries: listed.entries, more: listed.more, commits: log.code === 0 ? parseGitLog(log.out) : [] }
  })
}

/**
 * One file's diff. The path is whatever the page asked for, so it is used only if git, asked again
 * just now, lists exactly that path as changed in exactly that way. It is then an argument after
 * `--`, read as a name and never as a pattern, to a diff that can start no program.
 */
export function readGitDiff(folder: string, path: unknown, mode: unknown, baseEnv: Record<string, string | undefined> = process.env, topAllowed: (top: string) => boolean = () => true): Promise<GitDiff> {
  if (!gitPathOk(path) || (mode !== 'staged' && mode !== 'unstaged' && mode !== 'untracked')) return Promise.resolve({ kind: 'none' })
  return turn(async (): Promise<GitDiff> => {
    const o = await open(folder, baseEnv, topAllowed)
    if ('kind' in o) return o
    const out = await status(o, folder)
    if (typeof out !== 'string') return out
    const entry = parseGitEntries(out)?.entries.find((e) => e.path === path)
    if (!entry || !entryHasDiff(entry, mode)) return { kind: 'none' }
    // A file git does not track is read by Beacon itself, with its own checks (git-untracked.ts).
    if (mode === 'untracked') return readUntracked(o.at.top, path)
    const args = gitDiffArgs(mode, path)
    if (!args) return { kind: 'none' }
    // What a tracked file's diff prints comes from the repository's index and history: only if they are its own.
    if (!(await ownStore(o))) return { kind: 'unreadable', why: GIT_BORROWED }
    const r = await run([o.git, ...args], o.at.top, o.env)
    if (r.timedOut) return { kind: 'unreadable', why: GIT_TOO_SLOW }
    if (r.tooBig) return { kind: 'unreadable', why: GIT_DIFF_TOO_BIG }
    if (r.code !== 0) return { kind: 'unreadable', why: GIT_NOT_READ }
    return { kind: 'diff', ...clipDiff(r.out) }
  })
}
