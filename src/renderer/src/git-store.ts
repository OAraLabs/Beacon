import { useEffect, useSyncExternalStore } from 'react'
import type { GitRead } from '@shared/git-state'
import { gitStale } from '@shared/git-view'
import type { GitPrRead } from '@shared/git-pr'

// What git says about each conversation's work folder, for this window. A module singleton: the
// session list, the header chip and the Git pane all read the same answers.
//
// - Nothing is asked unless Prometheus shares this computer's disk (main proves that). With a
//   Prometheus elsewhere this store stays empty and costs nothing.
// - A row asks only while it is on screen and the window is showing; the open conversation asks
//   more often, and at once when a turn ends or its folder changes.
// - At most a few questions are with main at a time, the open conversation's first, so a full
//   list coming into view is a short queue and not thirty questions at once.
// - Answers belong to the connection they were asked on. When the Prometheus changes or
//   reconnects, what is known is dropped and an answer still on its way is ignored.

/** Dispatched on `window` with a session id when that conversation's folder changes (WorkFolderChip, Checkpoints). */
const WORKSPACE_CHANGED = 'beacon:workspace-changed'
/** Questions with main at once. */
const AT_ONCE = 3

interface Entry {
  read: GitRead
  at: number
}
const entries = new Map<string, Entry>()
/** Each conversation's pull request, asked for less often than its git state (it is a question to GitHub). */
const prs = new Map<string, { read: GitPrRead; at: number; branch: string; retry: boolean }>()
const prAsking = new Set<string>()
const prQueue: { sessionId: string; branch: string }[] = []
const PR_OPEN_MS = 60_000
const PR_ROW_MS = 5 * 60_000
/** After "could not be told just now". */
const PR_RETRY_MS = 30_000
const subs = new Map<string, Set<() => void>>()
/** With main now, and whether to ask again when the answer comes (something changed meanwhile). */
const asking = new Map<string, { again: boolean }>()
const queue: string[] = []
const openIds = new Set<string>()
let epoch = 0
/** null: not known yet. */
let here: boolean | null = null
let hereAsking = false
let hereTries = 0
const hereSubs = new Set<() => void>()

const notify = (sessionId: string): void => subs.get(sessionId)?.forEach((fn) => fn())
const notifyAll = (): void => {
  subs.forEach((set) => set.forEach((fn) => fn()))
  hereSubs.forEach((fn) => fn())
}
const showing = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'

function askHere(): void {
  const b = window.beacon
  if (!b || hereAsking || here !== null) return
  hereAsking = true
  const asked = epoch
  void b.workFolder
    .where()
    .then(
      (w) => (w.verdict === 'unknown' ? null : w.here === true),
      () => null
    )
    .then((answer) => {
      hereAsking = false
      if (asked !== epoch) return askHere() // the connection changed while this was asked
      if (answer === null) {
        // Could not be told just now: not "no". Asked again, less and less often.
        window.setTimeout(askHere, Math.min(30_000, 1000 * 2 ** hereTries++))
        return
      }
      hereTries = 0
      here = answer
      hereSubs.forEach((fn) => fn())
    })
}

let started = false
function start(): void {
  if (started || !window.beacon) return
  started = true
  let gateway: string | null | undefined
  let state: string | undefined
  window.beacon.connection.onStatus((s) => {
    const reconnected = s.state === 'connected' && state !== 'connected' && state !== undefined
    if ((gateway !== undefined && s.gateway !== gateway) || reconnected) {
      // Another Prometheus, or the same one back: what was known was the other's. Answers still
      // on their way are ignored (they carry the old epoch).
      epoch++
      here = null
      hereTries = 0
      entries.clear()
      prs.clear()
      prAsking.clear()
      prQueue.length = 0
      asking.clear()
      queue.length = 0
      notifyAll()
    }
    gateway = s.gateway
    state = s.state
  })
  window.addEventListener(WORKSPACE_CHANGED, (e) => {
    const id = (e as CustomEvent<unknown>).detail
    if (typeof id === 'string') requestGit(id, { force: true })
  })
  document.addEventListener('visibilitychange', () => {
    if (showing()) notifyAll() // watchers ask again as they re-render
  })
}

function pump(): void {
  const b = window.beacon
  if (!b || here !== true) return
  while (asking.size < AT_ONCE && queue.length > 0) {
    // The open conversation first.
    const at = queue.findIndex((id) => openIds.has(id))
    const sessionId = queue.splice(at >= 0 ? at : 0, 1)[0]
    const asked = epoch
    asking.set(sessionId, { again: false })
    void b.git
      .read(sessionId)
      .then(
        (read) => {
          if (asked !== epoch) return
          const was = entries.get(sessionId)
          entries.set(sessionId, { read, at: Date.now() })
          if (!was || JSON.stringify(was.read) !== JSON.stringify(read)) notify(sessionId)
          requestPr(sessionId, read, openIds.has(sessionId))
        },
        () => undefined
      )
      .finally(() => {
        if (asked !== epoch) return
        const again = asking.get(sessionId)?.again === true
        asking.delete(sessionId)
        if (again) queue.push(sessionId)
        pump()
      })
  }
}

/** Ask for the branch's pull request, when the folder is a repository on a branch with an
 *  upstream, and what is known is old or was about another branch. One question to main at a
 *  time, the open conversation's first: each may become a question to GitHub. */
function requestPr(sessionId: string, read: GitRead, open: boolean): void {
  if (!window.beacon) return
  const branch = read.kind === 'state' && read.state.branch && read.state.upstream ? read.state.branch : null
  const known = prs.get(sessionId)
  // Another branch (or none): what was known was about the old one. It goes at once, before the
  // new answer, so one branch's pull request is never shown beside another's name.
  if (known && known.branch !== branch) {
    prs.delete(sessionId)
    notify(sessionId)
  }
  if (branch === null) return
  const now = prs.get(sessionId)
  if (now && Date.now() - now.at < (now.retry ? PR_RETRY_MS : open ? PR_OPEN_MS : PR_ROW_MS)) return
  if (prAsking.has(sessionId) || prQueue.some((q) => q.sessionId === sessionId)) return
  prQueue.push({ sessionId, branch })
  pumpPr()
}

function pumpPr(): void {
  const b = window.beacon
  if (!b || prAsking.size >= 1 || prQueue.length === 0) return
  const at = prQueue.findIndex((q) => openIds.has(q.sessionId))
  const { sessionId, branch } = prQueue.splice(at >= 0 ? at : 0, 1)[0]
  const asked = epoch
  prAsking.add(sessionId)
  void b.git
    .pr(sessionId)
    .then(
      (pr) => {
        if (asked !== epoch) return
        const was = prs.get(sessionId)
        // "Could not be told just now": what was known stands (if it was about this branch), and it is asked again soon.
        if (pr.kind === 'unknown') {
          prs.set(sessionId, { read: was && was.branch === branch ? was.read : { kind: 'none' }, at: Date.now(), branch, retry: true })
          return
        }
        prs.set(sessionId, { read: pr, at: Date.now(), branch, retry: false })
        if (!was || JSON.stringify(was.read) !== JSON.stringify(pr)) notify(sessionId)
      },
      () => undefined
    )
    .finally(() => {
      if (asked !== epoch) return
      prAsking.delete(sessionId)
      pumpPr()
    })
}

/** Ask for a conversation's git state if what is known is old (or `force`). */
export function requestGit(sessionId: string, opts: { open?: boolean; force?: boolean } = {}): void {
  if (!window.beacon || !sessionId) return
  start()
  if (here === null) return askHere() // watchers ask again once the answer is in
  if (!here) return
  const going = asking.get(sessionId)
  if (going) {
    if (opts.force) going.again = true // what is being read may already be out of date
    return
  }
  if (queue.includes(sessionId)) return
  const known = entries.get(sessionId)
  if (known && !opts.force && !gitStale(Date.now() - known.at, opts.open === true)) {
    requestPr(sessionId, known.read, opts.open === true) // the pull request has its own, slower clock
    return
  }
  queue.push(sessionId)
  pump()
}

/**
 * A conversation's git state, kept fresh while `watch` is true (the row is on screen, or the
 * conversation is open) and the window is showing. `open` asks more often, first in the queue,
 * and again whenever `refreshKey` changes (a turn ended).
 */
export function useGit(sessionId: string | null | undefined, opts: { watch: boolean; open?: boolean; refreshKey?: unknown }): GitRead | null {
  const { watch, open, refreshKey } = opts
  const id = sessionId ?? ''
  const read = useSyncExternalStore(
    (cb) => {
      const set = subs.get(id) ?? new Set()
      subs.set(id, set)
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) subs.delete(id)
      }
    },
    () => entries.get(id)?.read ?? null
  )
  const hereKnown = useSyncExternalStore(
    (cb) => {
      hereSubs.add(cb)
      return () => hereSubs.delete(cb)
    },
    () => here
  )
  useEffect(() => {
    if (!id || !open) return
    openIds.add(id)
    return () => void openIds.delete(id)
  }, [id, open])
  useEffect(() => {
    if (!id || !watch) return
    const ask = (): void => {
      if (showing()) requestGit(id, { open })
    }
    ask()
    const timer = window.setInterval(ask, open ? 5_000 : 20_000)
    window.addEventListener('focus', ask)
    document.addEventListener('visibilitychange', ask)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', ask)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [id, watch, open, hereKnown])
  useEffect(() => {
    if (id && watch && refreshKey !== undefined) requestGit(id, { open, force: true })
    // Only a change of the key asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])
  return read
}

/** The pull request for a conversation's branch, as last learned (the git state's watcher asks for it). */
export function usePr(sessionId: string | null | undefined): GitPrRead | null {
  const id = sessionId ?? ''
  return useSyncExternalStore(
    (cb) => {
      const set = subs.get(id) ?? new Set()
      subs.set(id, set)
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) subs.delete(id)
      }
    },
    () => prs.get(id)?.read ?? null
  )
}
