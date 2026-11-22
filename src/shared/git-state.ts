// What git says about a conversation's work folder: the branch, how far it is from its upstream,
// and how many files are changed. Pure (no Node, no Electron): the commands to run, the
// environment to run them in, and the parser for what comes back. Main runs them (git-reader.ts).
//
// WHY THIS IS CAREFUL. The work folder is where the assistant works: it can write any file in it,
// `.git/config` included. Plain `git status` in such a folder runs programs that config names
// (`core.fsmonitor`, a `filter.<name>.clean` picked by a .gitattributes line, a submodule's own
// config), with nobody asked. The assistant's commands go through Prometheus's approval gate;
// a program Beacon's git started for it would not. So:
//
//   1. THE FLOOR: git is started with a process limit of zero, so it cannot start ANY other
//      program, whatever the folder's config says. `git status` needs none. This holds even for a
//      config key nobody has thought of. Main checks once that the limit is enforced on this
//      computer, and reads nothing if it is not.
//   2. The known ways are also switched off by name, so status succeeds instead of failing on a
//      refused fork: fsmonitor, hooks, submodule recursion, the threads git would otherwise start
//      (which the limit counts on Linux).
//   3. Only read-only commands with fixed arguments. Nothing the folder says is ever an argument.
//   4. A bare environment: no GIT_* variable from Beacon's own environment reaches git.

/** `sh -c` script that drops the process limit to zero, then becomes the command given as its
 *  arguments. The command and its arguments are positional parameters, never part of the script.
 *  (`-u` is the limit's name in most shells, `-p` in dash. Whether it then really binds is checked
 *  by running something under it: main's self-test.) */
export const NO_FORK_SCRIPT = 'ulimit -u 0 2>/dev/null || ulimit -p 0 2>/dev/null || exit 97; exec "$@"'
/** The exit code that means the limit could not be set (nothing was run). */
export const NO_FORK_UNSET = 97

/** Settings given on the command line, which win over the folder's own config. */
const SAFE_CONFIG = [
  'core.fsmonitor=false', // would run a program named in config on every status
  'core.hooksPath=/dev/null', // no hook, whatever an index refresh would trigger
  'core.preloadIndex=false', // threads: counted by the process limit on Linux
  'index.threads=1',
  'core.untrackedCache=false', // read-only: never rewrite the index to keep a cache
  'safe.bareRepository=explicit', // a folder dressed up as a bare repository is not one
  'status.submoduleSummary=false',
  'advice.statusHints=false',
  'color.ui=false'
] as const

const withConfig = (args: readonly string[]): string[] => [...SAFE_CONFIG.flatMap((c) => ['-c', c]), '--no-optional-locks', '--no-pager', ...args]

/** What every read-only git command starts with: the settings above, no locks, no pager. */
export const GIT_SAFE_PREFIX: readonly string[] = withConfig([])

/** Whether the folder is inside a work tree, then the repository's top folder, then its git folder,
 *  one per line. Fails outside a repository. */
export const GIT_WHERE_ARGS: readonly string[] = withConfig(['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--absolute-git-dir'])

/** The status, machine-readable, NUL-separated. Renames are not followed (a rename is two entries),
 *  submodules are not entered, and untracked folders are one entry each. */
export const GIT_STATUS_ARGS: readonly string[] = withConfig(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all', '--no-renames'])

/**
 * Where `git` is looked for: a FIXED list of system folders, never Beacon's own PATH. git runs with
 * the work folder as its current folder, and the shell finds `git` by walking PATH: a PATH with an
 * empty entry, a `.`, or `node_modules/.bin` (any of which a terminal or a dev run can have) would
 * find a file named `git` that the assistant wrote in the folder, and becoming that program needs
 * no new process, so the process limit would not stop it. System folders first.
 */
export const GIT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'
/** The same without /usr/bin, for a Mac with no developer tools: there /usr/bin/git is a stub
 *  that puts up an "install the command line tools" dialog every time it is run. */
export const GIT_PATH_NO_STUB = '/usr/local/bin:/opt/homebrew/bin:/bin:/usr/sbin:/sbin'

/** The environment git runs in: the fixed search path above, the person's home (their own config is
 *  theirs), plain C messages, and nothing else. In particular no PATH, GIT_DIR, GIT_CONFIG_*,
 *  GIT_EXEC_PATH or GIT_SSH from whatever started Beacon. */
export function gitReadEnv(base: Record<string, string | undefined>, opts: { noStub?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: opts.noStub ? GIT_PATH_NO_STUB : GIT_PATH,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat'
  }
  if (base.HOME && base.HOME.startsWith('/')) {
    env.HOME = base.HOME
    // git looks for a repository in the folder and then in each folder above it. It stops below
    // the home folder: a home that is itself a repository (dotfiles) would otherwise be read,
    // whole, for any work folder inside it.
    env.GIT_CEILING_DIRECTORIES = base.HOME
  }
  return env
}

/** Something under way in the repository that changes what "the branch" means. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface GitState {
  /** The branch name, or null when HEAD is detached (or the repository has no commit yet and no name). */
  branch: string | null
  /** HEAD's commit, short; null before the first commit. */
  commit: string | null
  /** The branch this one tracks (`origin/main`), or null. */
  upstream: string | null
  /** Commits here that the upstream lacks, and the other way. Null when there is no upstream, or it is gone. */
  ahead: number | null
  behind: number | null
  /** Files with a change in the index, in the folder, untracked, and in conflict. A file changed in
   *  both the index and the folder counts once in each. */
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Distinct paths with any change: the number a person means by "changed files". */
  changed: number
  operation: GitOperation | null
}

/** The most entries read from one status. Past it the counts say "at least this many". */
export const GIT_MAX_ENTRIES = 5000

/**
 * Parse `git status --porcelain=v2 --branch -z` output. Null when it is not that (no header at
 * all), so garbage is never shown as "a clean repository". Branch and upstream names are kept as
 * git wrote them; showing them safely is the view's job (`gitText`).
 */
export function parseGitStatus(out: string): (Omit<GitState, 'operation'> & { truncated: boolean }) | null {
  if (typeof out !== 'string' || !out.startsWith('# branch.')) return null
  const records = out.split('\0')
  let branch: string | null = null
  let commit: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  let changed = 0
  let seen = 0
  let truncated = false
  let inHeader = true
  for (const rec of records) {
    if (rec === '') continue
    // Headers come first and only first. After the first entry a record that looks like one is
    // not one (git writes none there), so nothing later in the output can restate the branch.
    if (inHeader && rec.startsWith('# ')) {
      const m = /^# branch\.(oid|head|upstream|ab) (.*)$/s.exec(rec)
      if (!m) continue
      const v = m[2]
      if (m[1] === 'oid') commit = /^[0-9a-f]{7,64}$/.test(v) ? v.slice(0, 7) : null
      else if (m[1] === 'head') branch = v === '(detached)' || v === '(unknown)' ? null : v
      else if (m[1] === 'upstream') upstream = v
      else {
        const ab = /^\+(\d{1,9}) -(\d{1,9})$/.exec(v)
        if (ab) {
          ahead = Number(ab[1])
          behind = Number(ab[2])
        }
      }
      continue
    }
    inHeader = false
    if (++seen > GIT_MAX_ENTRIES) {
      truncated = true
      break
    }
    const kind = rec[0]
    if (kind === '?') {
      untracked++
      changed++
    } else if (kind === 'u') {
      conflicted++
      changed++
    } else if (kind === '2') {
      return null // a rename record: never written with --no-renames, and its second path is not read here
    } else if (kind === '1') {
      // "1 XY …": X is the index, Y the folder; '.' is "no change there".
      const x = rec[2]
      const y = rec[3]
      if (x === undefined || y === undefined || rec[1] !== ' ') return null
      if (x !== '.') staged++
      if (y !== '.') unstaged++
      changed++
    } else if (kind === '!') {
      continue // ignored files: not asked for, not counted
    } else {
      return null // not a line this format has: do not guess
    }
  }
  return { branch, commit, upstream, ahead, behind, staged, unstaged, untracked, conflicted, changed, truncated }
}

/** What is under way, from the names found in the repository's git folder. */
export function gitOperation(namesInGitDir: readonly string[]): GitOperation | null {
  const has = (n: string): boolean => namesInGitDir.includes(n)
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  // Between two commits of a several-commit cherry-pick or revert neither file is there; the list of what is left is.
  if (has('sequencer')) return 'cherry-pick'
  if (has('BISECT_LOG')) return 'bisect'
  return null
}

/**
 * What `GIT_WHERE_ARGS` prints (whether the folder is inside the work tree, the repository's top,
 * its git folder), or null when it is not that, or when the repository is not plainly HERE:
 * - the folder must be inside the work tree git found (asked of git, so links in the path do not
 *   matter), and
 * - the git folder must be that top's own `.git`, or a linked worktree's or a submodule's
 *   (`…/.git/worktrees/<name>`, or `…/.git/modules/…` under a folder above the top). For a linked
 *   worktree (`linked`), main also checks that the store names this folder back (`worktreeNamesBack`).
 * A repository's config can point git at any folder (`core.worktree`, a `.git` file naming
 * another place). The assistant writes that config, and Beacon does not go and read whatever
 * folder it names: with `core.worktree` set, the top is no longer the folder that holds `.git`.
 */
export function parseGitWhere(out: string): { top: string; gitDir: string; linked: boolean } | null {
  const lines = out.split('\n').filter((l) => l !== '')
  if (lines.length !== 3 || lines[0] !== 'true' || !lines[1].startsWith('/') || !lines[2].startsWith('/')) return null
  const [, top, gitDir] = lines
  const own = gitDir === (top === '/' ? '/.git' : `${top}/.git`)
  const worktree = /\/\.git\/worktrees\/[^/]+$/.test(gitDir)
  // A submodule's git folder is inside the repository that holds it: `<a folder above top>/.git/modules/…`.
  // One that is somewhere else is another repository's, named by a `.git` file the assistant wrote.
  const at = gitDir.indexOf('/.git/modules/')
  const submodule = at > 0 && top.startsWith(`${gitDir.slice(0, at)}/`)
  return own || worktree || submodule ? { top, gitDir, linked: worktree } : null
}

const squash = (p: string): string => {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}
/** On a Mac /tmp, /var and /etc are also /private/tmp and so on: one folder, two spellings. */
const unprivate = (p: string): string => p.replace(/^\/private\/(tmp|var|etc)(?=\/|$)/, '/$1')

/**
 * Whether a linked worktree's store names THIS folder back. A linked worktree is two halves: the
 * folder's `.git` file names a store (`<main>/.git/worktrees/<name>`), and that store's `gitdir`
 * file names the folder's `.git`. The assistant can write the first half and point it at any
 * repository's existing worktree store on this computer; it cannot write the second (that is
 * inside the other repository). `gitdirFile` is the store's `gitdir` file as read.
 */
export function worktreeNamesBack(top: string, gitDir: string, gitdirFile: string): boolean {
  const named = gitdirFile.split('\n')[0].trim()
  if (named === '') return false
  const full = squash(named.startsWith('/') ? named : `${gitDir}/${named}`)
  return unprivate(full) === unprivate(squash(`${top}/.git`))
}

/** What reading a folder came to. */
export type GitRead =
  | { kind: 'state'; state: GitState; top: string; truncated: boolean }
  /** Not inside a git repository (or git is not installed): nothing to show. */
  | { kind: 'none' }
  /** A repository, but it could not be read safely or in time. `why` is fixed words. */
  | { kind: 'unreadable'; why: string }

export const GIT_UNSAFE_HERE = 'Beacon cannot limit what git may start on this computer, so it does not read git here.'
export const GIT_TOO_SLOW = 'Git did not answer in time.'
export const GIT_NOT_READ = 'Git could not read this folder.'

/**
 * A name git gave (a branch, an upstream) as it may be shown: characters that are not part of what
 * a person reads are removed, and a long name is cut. A branch name is chosen by whoever made the
 * branch, the assistant included.
 */
export function gitText(raw: string | null | undefined, max = 60): string {
  const cleaned = (raw ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/gu, '').trim()
  const chars = Array.from(cleaned)
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join('')}…`
}

// ── The Git panel: which files are changed, a file's diff, the commits not yet upstream ──────
// The same floor as the status above (no program can be started), and the same care: `git diff`
// has its own ways to run a program a repository names (an external diff tool, a textconv
// filter), switched off by name here as well, and the one argument that is not fixed, the path,
// is taken only from what git itself just listed, after `--`, never read as a pattern.

/** One changed path, as status listed it. */
export interface GitEntry {
  /** Relative to the repository's top, exactly as git wrote it. Shown through `gitText`. */
  path: string
  /** The one-letter states in the index and in the folder ('.' is "no change there"). */
  index: string
  tree: string
  kind: 'changed' | 'untracked' | 'conflicted'
}

/** The most entries the panel lists. */
export const GIT_ENTRIES_MAX = 300

/** The entries of a status (the same output `parseGitStatus` counts), or null when it is not one. */
export function parseGitEntries(out: string): { entries: GitEntry[]; more: number } | null {
  if (typeof out !== 'string' || !out.startsWith('# branch.')) return null
  const entries: GitEntry[] = []
  let more = 0
  let inHeader = true
  const push = (e: GitEntry): void => {
    if (entries.length < GIT_ENTRIES_MAX) entries.push(e)
    else more++
  }
  for (const rec of out.split('\0')) {
    if (rec === '') continue
    if (inHeader && rec.startsWith('# ')) continue
    inHeader = false
    const kind = rec[0]
    if (kind === '?') {
      if (rec[1] !== ' ' || rec.length < 3) return null
      push({ path: rec.slice(2), index: '.', tree: '?', kind: 'untracked' })
    } else if (kind === '1' || kind === 'u') {
      // "1 XY sub mH mI mW hH hI path" has 8 fields before the path; "u XY sub m1 m2 m3 mW h1 h2 h3 path" has 10.
      const before = kind === '1' ? 8 : 10
      const fields = rec.split(' ')
      if (fields.length <= before || fields[1].length !== 2) return null
      const path = fields.slice(before).join(' ')
      if (path === '') return null
      push({ path, index: fields[1][0], tree: fields[1][1], kind: kind === 'u' ? 'conflicted' : 'changed' })
    } else if (kind === '!') {
      continue
    } else {
      return null
    }
  }
  return { entries, more }
}

/** Which side of a file's change to show. */
export type GitDiffMode = 'staged' | 'unstaged' | 'untracked'

/** Whether an entry has a diff of this kind. An untracked FOLDER (its path ends in `/`) has none. */
export function entryHasDiff(e: GitEntry, mode: GitDiffMode): boolean {
  if (mode === 'untracked') return e.kind === 'untracked' && !e.path.endsWith('/')
  if (e.kind === 'untracked') return false
  return mode === 'staged' ? e.index !== '.' : e.tree !== '.'
}

/** A path git listed, as an argument: relative, no `..` part, nothing git could take for an option. */
export function gitPathOk(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0') && !path.startsWith('/') && !path.startsWith('-') && !path.split('/').includes('..')
}

const DIFF_COMMON = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3'] as const

/** The arguments for one file's diff, run from the repository's top, or null for a path that is not one. */
export function gitDiffArgs(mode: GitDiffMode, path: string): string[] | null {
  if (!gitPathOk(path)) return null
  // An untracked file is not git's to diff: main reads it itself (git-untracked.ts says why).
  if (mode === 'untracked') return null
  // `--literal-pathspecs`: the path is a name, never a pattern (`:(top)…`, `*`).
  const head = withConfig([]).concat('--literal-pathspecs')
  return [...head, 'diff', ...(mode === 'staged' ? ['--cached'] : []), ...DIFF_COMMON, '--', path]
}

/** The commits on this branch that its upstream lacks, newest first: short hash, a tab, the subject; NUL between. */
export const GIT_LOG_ARGS: readonly string[] = [...withConfig([]), '-c', 'log.showSignature=false', 'log', '--no-show-signature', '--no-color', '--no-decorate', '-z', '--format=%h%x09%s', '-n', '30', '@{upstream}..HEAD']

export interface GitCommit {
  hash: string
  subject: string
}

export function parseGitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const rec of (out ?? '').split('\0')) {
    const m = /^([0-9a-f]{4,40})\t(.*)$/s.exec(rec.replace(/^\n+/, ''))
    if (m) commits.push({ hash: m[1], subject: m[2].split('\n')[0] })
  }
  return commits
}

/** What the panel lists. */
export type GitDetail =
  | { kind: 'detail'; entries: GitEntry[]; more: number; commits: GitCommit[] }
  | { kind: 'none' }
  | { kind: 'unreadable'; why: string }

/** Where the repository keeps what it has committed: the folder shared by all its worktrees. */
export const GIT_COMMON_ARGS: readonly string[] = withConfig(['rev-parse', '--path-format=absolute', '--git-common-dir'])

/** The names directly inside a repository's git folder that, as LINKS, would have it read another
 *  repository's index, refs or objects. */
const STORE_NAMES = new Set(['HEAD', 'index', 'packed-refs', 'objects', 'refs', 'config', 'commondir', 'info', 'shallow'])

/** The arguments (to `find`, twice) that list links where a repository's own store should be: at
 *  the top of each git folder, and anywhere under refs and objects (a loose object or a ref that
 *  is a link to another repository's is that repository's content). */
export function storeLinkArgs(gitDir: string, common: string): { top: string[]; deep: string[] } {
  return { top: ['-P', ...new Set([common, gitDir]), '-maxdepth', '1', '-type', 'l'], deep: ['-P', `${common}/refs`, `${common}/objects`, '-type', 'l'] }
}

/**
 * Whether a repository's history and index are its OWN, so that what a diff or a log prints comes
 * from this repository and nowhere else. A repository can be made to borrow another's: a
 * `commondir` file, an `alternates` list, or links in place of its index, refs or objects.
 * A diff would then print another repository's committed files under this folder's name. So:
 * - the common folder git reports must be the git folder itself, or the one a linked worktree
 *   hangs off (`<common>/worktrees/<name>`);
 * - there is no alternates list;
 * - none of the store's names at the top of a git folder is a link, and nothing under refs or
 *   objects is.
 * `topLinks` and `deepLinks` are what `find` printed for `storeLinkArgs`; `infoNames` the names in
 * `<common>/objects/info`.
 * This is not a wall: whoever can write the folder can also copy files into it, and what is shown
 * is shown to the person only. It keeps the panel from being pointed at another repository by a
 * line of configuration or a link.
 */
export function storeIsOwn(gitDir: string, common: string, infoNames: readonly string[], topLinks: readonly string[], deepLinks: readonly string[]): boolean {
  const worktree = gitDir.startsWith(`${common}/worktrees/`) && !gitDir.slice(`${common}/worktrees/`.length).includes('/')
  if (common !== gitDir && !worktree) return false
  if (infoNames.includes('alternates') || infoNames.includes('http-alternates')) return false
  if (deepLinks.some((l) => l !== '')) return false
  for (const link of topLinks) {
    if (link === '') continue
    const cut = link.lastIndexOf('/')
    if ((link.slice(0, cut) === common || link.slice(0, cut) === gitDir) && STORE_NAMES.has(link.slice(cut + 1))) return false
  }
  return true
}

export const GIT_BORROWED = 'This repository reads from another one on this computer (a shared or linked store), so Beacon does not show what its files contain.'

/** The most of a diff that is shown: characters, and lines (each line is drawn on its own). */
export const GIT_DIFF_SHOW_MAX = 200_000
export const GIT_DIFF_LINES_MAX = 5000

export type GitDiff =
  | { kind: 'diff'; text: string; truncated: boolean }
  /** The file is no longer listed as changed that way (it was committed, reverted, or never was). */
  | { kind: 'none' }
  | { kind: 'unreadable'; why: string }

export const GIT_DIFF_TOO_BIG = 'This change is too large to show here.'

/** A diff as shown: cut at the limit, on a line. Nothing else is done to it; the view shows it as text. */
export function clipDiff(text: string): { text: string; truncated: boolean } {
  let out = text
  let truncated = false
  if (out.length > GIT_DIFF_SHOW_MAX) {
    const cut = out.lastIndexOf('\n', GIT_DIFF_SHOW_MAX)
    out = out.slice(0, cut > 0 ? cut : GIT_DIFF_SHOW_MAX)
    truncated = true
  }
  // A change of thousands of short lines is as heavy to draw as a long one.
  let at = -1
  for (let n = 0; n < GIT_DIFF_LINES_MAX; n++) {
    at = out.indexOf('\n', at + 1)
    if (at < 0) return { text: out, truncated }
  }
  return at + 1 < out.length ? { text: out.slice(0, at), truncated: true } : { text: out, truncated }
}

/** A diff line as drawn: the characters that reorder, hide or break text on screen (direction
 *  marks, overrides and isolates, zero-width characters, stray line separators) are taken out, so
 *  a line reads in the order its characters are in, on one line. */
export function diffLineShown(line: string): string {
  return line.replace(/[\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\r]/g, '')
}
