// A conversation's pull request (@shared/git-pr says how and why). Three small git reads under
// the usual floor find where the branch is pushed; then `gh`, outside the repository, is asked
// about that branch of that repository. Answers are remembered for a minute, so a row and a
// header asking together are one question to GitHub.
import { spawn } from 'node:child_process'
import {
  GH_PLACES,
  GIT_BRANCHES_ARGS,
  GIT_HEAD_ARGS,
  GIT_REMOTES_ARGS,
  PR_FAILED_MS,
  PR_FRESH_MS,
  PR_NO_GH_MS,
  PR_PER_MINUTE,
  PR_STALLED_MS,
  ghEnv,
  ghPrArgs,
  githubRepo,
  parseGhPrs,
  remoteUrl,
  upstreamOf,
  type GitPrRead
} from '@shared/git-pr'
import { open, run, turn } from './git-reader'

const GH_TIME_MS = 8000
const GH_OUT_MAX = 1024 * 1024
const NONE: GitPrRead = { kind: 'none' }
const UNKNOWN: GitPrRead = { kind: 'unknown' }

interface GhRan {
  /** The program was not there. */
  missing: boolean
  /** It had to be stopped: no answer in time. */
  stalled: boolean
  code: number | null
  out: string
}

/**
 * `gh` itself: at the top of the disk, never in the work folder, with a time and output limit.
 * Not under the process limit (it starts the system's keychain tool to sign in), so it is started
 * as the head of its own process group and, if it has to be stopped, the whole group is: a
 * keychain helper left waiting behind it would otherwise stay.
 */
function gh(place: string, args: readonly string[], env: Record<string, string>): Promise<GhRan> {
  return new Promise((resolve) => {
    let out = ''
    let over = false
    let done = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(place, [...args], { cwd: '/', env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolve({ missing: true, stalled: false, code: null, out: '' })
    }
    const stopAll = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const finish = (r: GhRan): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      stopAll()
      finish({ missing: false, stalled: true, code: null, out: '' })
    }, GH_TIME_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (over) return
      out += d
      if (out.length > GH_OUT_MAX) {
        over = true
        stopAll()
      }
    })
    child.on('error', (e: Error & { code?: string }) => finish({ missing: e.code === 'ENOENT', stalled: false, code: null, out: '' }))
    child.on('close', (code) => finish({ missing: false, stalled: false, code: over ? null : code, out: over ? '' : out }))
  })
}

/** Remembered answers, by repository and branch; when `gh` was last found absent, or had to be stopped. */
const known = new Map<string, { at: number; good: boolean; read: GitPrRead }>()
const asking = new Map<string, Promise<GitPrRead>>()
let places: readonly string[] = GH_PLACES
let noGhSince = 0
let stalledAt = 0
let ghPlace: string | null = null
/** When each recent question was put: no more than PR_PER_MINUTE in a minute, and one at a time. */
const asked: number[] = []
let busy: Promise<unknown> = Promise.resolve()

const remember = (key: string, good: boolean, read: GitPrRead): void => {
  known.delete(key)
  known.set(key, { at: Date.now(), good, read })
  while (known.size > 300) known.delete(known.keys().next().value as string)
}

async function ask(repo: string, branch: string, args: string[], baseEnv: Record<string, string | undefined>): Promise<GitPrRead> {
  const now = Date.now()
  if (noGhSince && now - noGhSince < PR_NO_GH_MS) return NONE
  if (stalledAt && now - stalledAt < PR_STALLED_MS) return UNKNOWN
  while (asked.length > 0 && now - asked[0] >= 60_000) asked.shift()
  if (asked.length >= PR_PER_MINUTE) return UNKNOWN // asked again later; nothing is remembered
  asked.push(now)
  const env = ghEnv(baseEnv)
  const key = `${repo}\n${branch}`
  for (const place of ghPlace ? [ghPlace, ...places.filter((p) => p !== ghPlace)] : places) {
    const r = await gh(place, args, env)
    if (r.missing) continue
    ghPlace = place
    noGhSince = 0
    if (r.stalled) {
      stalledAt = Date.now()
      return UNKNOWN
    }
    // Not signed in, no network, no such repository for this account: not known, for a while.
    if (r.code !== 0) {
      remember(key, false, UNKNOWN)
      return UNKNOWN
    }
    const pr = parseGhPrs(r.out, repo, branch)
    const read: GitPrRead = pr ? { kind: 'pr', pr } : NONE
    remember(key, true, read)
    return read
  }
  ghPlace = null
  noGhSince = Date.now()
  return NONE
}

/** The pull request for the branch a folder's repository has checked out, or none. */
export async function readGitPr(folder: string, baseEnv: Record<string, string | undefined> = process.env, topAllowed: (top: string) => boolean = () => true): Promise<GitPrRead> {
  const where = await turn(async () => {
    const o = await open(folder, baseEnv, topAllowed)
    if ('kind' in o) return null
    const head = await run([o.git, ...GIT_HEAD_ARGS], folder, o.env)
    if (head.code !== 0) return null
    const branches = await run([o.git, ...GIT_BRANCHES_ARGS], folder, o.env)
    const up = branches.code === 0 ? upstreamOf(head.out, branches.out) : null
    if (!up) return null
    const remotes = await run([o.git, ...GIT_REMOTES_ARGS], folder, o.env)
    const repo = remotes.code === 0 ? githubRepo(remoteUrl(remotes.out, up.remote)) : null
    const args = ghPrArgs(repo, up.branch)
    return repo && args ? { repo, branch: up.branch, args } : null
  })
  // Too many git reads waiting their turn: not known just now.
  if (where && 'kind' in where) return UNKNOWN
  if (!where) return NONE
  const key = `${where.repo}\n${where.branch}`
  const kept = known.get(key)
  if (kept && Date.now() - kept.at < (kept.good ? PR_FRESH_MS : PR_FAILED_MS)) return kept.read
  const going = asking.get(key)
  if (going) return going
  // One gh at a time, in the order asked.
  const p = busy.then(() => ask(where.repo, where.branch, where.args, baseEnv)).finally(() => asking.delete(key))
  busy = p.catch(() => undefined)
  asking.set(key, p)
  return p
}

/** For the smoke: forget what was learned, and look for `gh` in these places instead. */
export function resetGitPr(look?: readonly string[]): void {
  known.clear()
  asking.clear()
  asked.length = 0
  noGhSince = 0
  stalledAt = 0
  ghPlace = null
  places = look ?? GH_PLACES
}
