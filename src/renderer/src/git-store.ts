import { useEffect, useSyncExternalStore } from 'react'
import type { GitRead } from '@shared/git-state'
import { gitStale } from '@shared/git-view'
import type { GitPrRead } from '@shared/git-pr'
import { GIT_DAEMON_OPEN_FRESH_MS, GIT_DAEMON_ROW_FRESH_MS, changedFrameSession, gitDaemonPath, parseDaemonGit, type DaemonGit } from '@shared/git-daemon'

// What git says about each conversation's work folder, for this window. A module singleton: the
// session list, the header chip and the Git pane all read the same answers.
//
// - A Prometheus that advertises git/1 reads git itself and says when it changed (a
//   `workspace_git_changed` frame): this store asks it, whatever computer it is on. Otherwise
//   nothing is asked unless Prometheus shares this computer's disk (main proves that, and reads git
//   itself). With neither, this store stays empty and costs nothing.
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
/** Whether this connection's Prometheus reads git for us (it advertised git/1, and this device is an owner).
 *  null: not known yet. Kept when the connection drops; reset when the Prometheus changes. */
let daemon: boolean | null = null
/** It advertised git/1 and then refused this device: this connection reads git itself, or not at all. */
let daemonDenied = false
let daemonTimer: number | null = null
/** A frame is acted on after a moment, once per conversation, however many arrive. */
const frameTimers = new Map<string, number>()
const FRAME_DELAY_MS = 500
/** A Prometheus too old to send `subscribed` is treated as one without git/1 after this long. */
const DAEMON_WAIT_MS = 6_000
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
      daemon = null
      daemonDenied = false
      if (daemonTimer !== null) window.clearTimeout(daemonTimer)
      daemonTimer = null
      frameTimers.forEach((t) => window.clearTimeout(t))
      frameTimers.clear()
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
    applyStatus(s)
  })
  // The status that came before this window listened.
  void window.beacon.connection.status().then(
    (s) => {
      if (gateway === undefined) {
        gateway = s.gateway
        state = s.state
      }
      applyStatus(s)
    },
    () => undefined
  )
  // A change in a conversation's folder, said by the Prometheus that reads it.
  window.beacon.events.onGateway((ev) => {
    const id = changedFrameSession(ev)
    // Only for a conversation being watched, and a hidden window reads when it is shown again.
    if (!id || daemon !== true || !(entries.has(id) || openIds.has(id)) || (!showing() && !openIds.has(id)) || frameTimers.has(id)) return
    frameTimers.set(
      id,
      window.setTimeout(() => {
        frameTimers.delete(id)
        if (daemon === true) requestGit(id, { force: true })
      }, FRAME_DELAY_MS)
    )
  })
  window.addEventListener(WORKSPACE_CHANGED, (e) => {
    const id = (e as CustomEvent<unknown>).detail
    if (typeof id === 'string') requestGit(id, { force: true })
  })
  document.addEventListener('visibilitychange', () => {
    if (showing()) notifyAll() // watchers ask again as they re-render
  })
}

/** Learn from a connection status whether Prometheus reads git for us. */
function applyStatus(s: { state: string; gitStatus?: boolean; role?: string }): void {
  if (s.gitStatus === undefined) {
    // Not said yet. A Prometheus that never says is an old one: after a while, it is "no".
    if (daemon === null && s.state === 'connected' && daemonTimer === null) {
      const asked = epoch
      daemonTimer = window.setTimeout(() => {
        daemonTimer = null
        if (asked === epoch && daemon === null) setDaemon(false)
      }, DAEMON_WAIT_MS)
    }
    return
  }
  if (daemonTimer !== null) {
    window.clearTimeout(daemonTimer)
    daemonTimer = null
  }
  // A device that may only chat is not asked: the route is the owner's.
  setDaemon(s.gitStatus && s.role !== 'limited' && !daemonDenied)
}

function setDaemon(next: boolean): void {
  if (daemon === next) return
  daemon = next
  // The other source's answers are not this one's.
  epoch++
  frameTimers.forEach((t) => window.clearTimeout(t))
  frameTimers.clear()
  entries.clear()
  prs.clear()
  prAsking.clear()
  prQueue.length = 0
  asking.clear()
  queue.length = 0
  notifyAll()
}

/** One conversation's git state from the Prometheus, with the pull request that came with it. Null: no usable answer now. */
async function readDaemon(sessionId: string): Promise<DaemonGit | null> {
  const b = window.beacon
  const path = gitDaemonPath(sessionId)
  if (!b || !path) return null
  const asked = epoch
  try {
    return parseDaemonGit(await b.daemon.get(path))
  } catch (e) {
    // The route refuses this device (403): this connection stops asking. A 404 is one conversation the Prometheus does not know,
    // and a failure that was asked on another connection says nothing about this one.
    if (asked === epoch && /HTTP 403\b/.test(String((e as Error)?.message))) {
      daemonDenied = true
      setDaemon(false)
    }
    return null
  }
}

function pump(): void {
  const b = window.beacon
  if (!b || (daemon !== true && here !== true)) return
  while (asking.size < AT_ONCE && queue.length > 0) {
    // The open conversation first.
    const at = queue.findIndex((id) => openIds.has(id))
    const sessionId = queue.splice(at >= 0 ? at : 0, 1)[0]
    const asked = epoch
    asking.set(sessionId, { again: false })
    const viaDaemon = daemon === true
    void (viaDaemon ? readDaemon(sessionId) : b.git.read(sessionId).then((read): DaemonGit | null => ({ read, pr: { kind: 'unknown' } })))
      .then(
        (got) => {
          if (asked !== epoch || !got) return
          const { read } = got
          const was = entries.get(sessionId)
          entries.set(sessionId, { read, at: Date.now() })
          if (viaDaemon) setDaemonPr(sessionId, read, got.pr)
          if (!was || JSON.stringify(was.read) !== JSON.stringify(read)) notify(sessionId)
          if (!viaDaemon) requestPr(sessionId, read, openIds.has(sessionId))
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

/** The pull request that came with a daemon's answer: kept as the answer said, for that branch. */
function setDaemonPr(sessionId: string, read: GitRead, pr: GitPrRead): void {
  const was = prs.get(sessionId)
  const branch = read.kind === 'state' && read.state.branch ? read.state.branch : ''
  if (pr.kind === 'pr' && branch) {
    prs.set(sessionId, { read: pr, at: Date.now(), branch, retry: false })
    if (!was || JSON.stringify(was.read) !== JSON.stringify(pr)) notify(sessionId)
  } else if (was) {
    prs.delete(sessionId)
    notify(sessionId)
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

/** With a Prometheus that says when things change, a reading is taken again only as a safety net between its frames. */
const daemonStale = (age: number, open: boolean): boolean => !(age < (open ? GIT_DAEMON_OPEN_FRESH_MS : GIT_DAEMON_ROW_FRESH_MS))

/** Ask for a conversation's git state if what is known is old (or `force`). */
export function requestGit(sessionId: string, opts: { open?: boolean; force?: boolean } = {}): void {
  if (!window.beacon || !sessionId) return
  start()
  if (daemon === null) return // watchers ask again once it is known
  if (here === null) askHere() // asked either way: the Git pane needs it, and without a daemon it is the whole decision
  if (daemon !== true) {
    if (here === null) return // watchers ask again once the answer is in
    if (!here) return
  }
  const going = asking.get(sessionId)
  if (going) {
    if (opts.force) going.again = true // what is being read may already be out of date
    return
  }
  if (queue.includes(sessionId)) return
  const known = entries.get(sessionId)
  if (known && !opts.force && !(daemon === true ? daemonStale(Date.now() - known.at, opts.open === true) : gitStale(Date.now() - known.at, opts.open === true))) {
    if (daemon !== true) requestPr(sessionId, known.read, opts.open === true) // the pull request has its own, slower clock
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
    () => `${String(daemon)}:${String(here)}`
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

/**
 * Whether the Git pane can list files and diffs for this window: only when Prometheus is on this
 * computer (main reads those itself). false: the counts come from Prometheus, the files do not.
 * null: not known yet.
 */
export function useGitFilesHere(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      hereSubs.add(cb)
      return () => hereSubs.delete(cb)
    },
    () => here
  )
}
