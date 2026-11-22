// A branch's pull request, through `gh` on the computer that has the repository. Pure: which
// questions to put to git (fixed arguments), how to read a remote's address, the arguments for
// `gh`, and how to read its answer.
//
// - Beacon never holds a GitHub token. `gh` signs in with whatever it is signed in with.
// - `gh` is run OUTSIDE the repository (the top of the disk, a fixed environment), named the
//   repository and the branch as arguments. It never reads the work folder's own git settings.
//   It cannot run under the no-new-process limit the git reads use (it starts the system's
//   keychain tool to sign in), so everything it is given is validated here first.
// - Only github.com remotes. Anything else has no pull request state.
// - Without `gh`, or not signed in, there is simply none.
import { GIT_SAFE_PREFIX } from './git-state'

/** HEAD's full name (`refs/heads/main`), or `HEAD` when detached. */
export const GIT_HEAD_ARGS: readonly string[] = [...GIT_SAFE_PREFIX, 'rev-parse', '--symbolic-full-name', 'HEAD']
/** Every local branch with the remote it tracks and its name there: three NUL-separated fields a line. */
export const GIT_BRANCHES_ARGS: readonly string[] = [...GIT_SAFE_PREFIX, 'for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads']
/** Every remote's address: `remote.<name>.url`, a line break, the address, NUL. */
export const GIT_REMOTES_ARGS: readonly string[] = [...GIT_SAFE_PREFIX, 'config', '--null', '--get-regexp', '^remote\\..*\\.url$']

/** Where the current branch is pushed: the remote's name and the branch's name there. */
export function upstreamOf(headRef: string, branchesOut: string): { remote: string; branch: string } | null {
  const head = headRef.trim()
  if (!head.startsWith('refs/heads/')) return null
  for (const line of branchesOut.split('\n')) {
    const [ref, remote, remoteRef] = line.split('\0')
    if (ref !== head) continue
    if (!remote || !remoteRef || !remoteRef.startsWith('refs/heads/')) return null
    return { remote, branch: remoteRef.slice('refs/heads/'.length) }
  }
  return null
}

/** The address of one remote, from `GIT_REMOTES_ARGS` output. */
export function remoteUrl(remotesOut: string, remote: string): string | null {
  for (const rec of remotesOut.split('\0')) {
    const cut = rec.indexOf('\n')
    if (cut > 0 && rec.slice(0, cut) === `remote.${remote}.url`) return rec.slice(cut + 1)
  }
  return null
}

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?'
const FORMS = [
  new RegExp(`^https://github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?$`),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`)
]

/** `owner/name` for a github.com remote address, or null for anything else (another host, a
 *  local path, an address with a password or a port in it, odd characters). */
export function githubRepo(url: string | null | undefined): string | null {
  const u = (url ?? '').trim()
  for (const form of FORMS) {
    const m = form.exec(u)
    if (!m) continue
    const name = m[2].replace(/\.git$/, '')
    if (name === '' || name === '.' || name === '..' || m[1].includes('..') || name.includes('..')) return null
    return `${m[1]}/${name}`
  }
  return null
}

/** A branch name as an argument to `gh`: the characters branch names are made of, nothing an
 *  option could be mistaken for. */
export function branchOk(branch: unknown): branch is string {
  return typeof branch === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/@+-]{0,199}$/.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.lock')
}

/** The arguments for `gh`, or null when the repository or the branch is not one to ask about. */
export function ghPrArgs(repo: string | null, branch: unknown): string[] | null {
  if (!repo || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || !branchOk(branch)) return null
  return ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,state,isDraft,mergeable,url,statusCheckRollup,headRefName,isCrossRepository']
}

/** The environment `gh` runs in: where to find it and the keychain tool, the person's home (its
 *  own sign-in is theirs), no prompts, no colour. No token variable is ever set or passed on. */
export function ghEnv(base: Record<string, string | undefined>): Record<string, string> {
  // GH_HOST: the question goes to github.com, whatever host gh would otherwise prefer (someone
  // signed in to a company's own GitHub as well). The link Beacon shows is a github.com one.
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' }
  if (base.HOME && base.HOME.startsWith('/')) env.HOME = base.HOME
  // Where the person keeps gh's own settings and sign-in, if they moved them: theirs, passed on.
  for (const k of ['XDG_CONFIG_HOME', 'GH_CONFIG_DIR'] as const) {
    const v = base[k]
    if (v && v.startsWith('/')) env[k] = v
  }
  return env
}

/** Where `gh` may be: fixed places, tried in order. Never looked up through Beacon's own PATH. */
export const GH_PLACES: readonly string[] = Object.freeze(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'])

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none'

export interface GitPr {
  number: number
  state: PrState
  /** Whether it can be merged as it stands. */
  conflicts: boolean
  checks: PrChecks
  /** Built here from the repository and the number, never taken from the answer. */
  url: string
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function checksOf(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue
    const { status, conclusion, state } = c as { status?: unknown; conclusion?: unknown; state?: unknown }
    // A check run says `status` then `conclusion`; a commit status says `state`.
    const verdict = typeof conclusion === 'string' && conclusion !== '' ? conclusion : typeof state === 'string' ? state : ''
    if (FAILED.has(verdict)) return 'failing'
    if (!PASSED.has(verdict) || (typeof status === 'string' && status !== 'COMPLETED' && status !== '')) pending = true
  }
  return pending ? 'pending' : 'passing'
}

/**
 * The pull request for a branch, from `gh pr list … --json …` output: the open one if there is
 * one, otherwise the newest. Null when there is none, or the answer is not what was asked for
 * (not JSON, another branch's, a number that is not one).
 */
export function parseGhPrs(out: string, repo: string, branch: string): GitPr | null {
  let list: unknown
  try {
    list = JSON.parse(out)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  // Only this repository's own branch: `--head` matches by name, so a pull request from someone's
  // fork, from a branch of the same name, would otherwise be taken for this one.
  const mine = list.filter(
    (p): p is Record<string, unknown> =>
      !!p && typeof p === 'object' && (p as { headRefName?: unknown }).headRefName === branch && (p as { isCrossRepository?: unknown }).isCrossRepository === false && Number.isSafeInteger((p as { number?: unknown }).number) && (p as { number: number }).number > 0
  )
  const pick = mine.find((p) => p.state === 'OPEN') ?? mine[0]
  if (!pick) return null
  const number = pick.number as number
  const state: PrState | null = pick.state === 'MERGED' ? 'merged' : pick.state === 'CLOSED' ? 'closed' : pick.state === 'OPEN' ? (pick.isDraft === true ? 'draft' : 'open') : null
  if (!state) return null
  return { number, state, conflicts: pick.mergeable === 'CONFLICTING', checks: checksOf(pick.statusCheckRollup), url: `https://github.com/${repo}/pull/${number}` }
}

/** What reading a conversation's pull request came to. `unknown`: could not be told just now (gh
 *  did not answer, too many questions at once): what was known before stands, and it is asked again. */
export type GitPrRead = { kind: 'pr'; pr: GitPr } | { kind: 'none' } | { kind: 'unknown' }

/** How long an answer from GitHub is good for, and how long "there is no gh" or "it did not
 *  answer" is remembered before asking again. */
export const PR_FRESH_MS = 60_000
export const PR_NO_GH_MS = 10 * 60_000
export const PR_FAILED_MS = 2 * 60_000
/** The most questions put to GitHub in any one minute, whoever asks and about whatever. A branch
 *  can be renamed as fast as the assistant likes; each new name is a new question. */
export const PR_PER_MINUTE = 6
/** After gh has had to be stopped for not answering, nothing is asked for this long. */
export const PR_STALLED_MS = 5 * 60_000
