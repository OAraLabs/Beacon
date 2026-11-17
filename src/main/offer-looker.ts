// Main's side of the helper process that looks at and reads offered files (offer-look.ts).
//
// Main never touches an offered path itself. It asks the helper, one question at a time, and
// waits a bounded time. A question that is not answered in time means the disk is not answering:
// the helper is ended (a blocked file call cannot be taken back, but its process can be left
// behind) and the next question starts a fresh one. Main's own thread, and the file threads the
// rest of Beacon uses, are never the ones that wait.
import type { OfferStat } from '@shared/os-entry'
import type { LookAnswer, LookAsk, LookDirs } from './offer-look'

/** What the looker needs of a helper process: Electron's UtilityProcess, or a stand-in. */
export interface HelperProcess {
  postMessage(m: unknown): void
  on(event: 'message', fn: (m: LookAnswer) => void): unknown
  on(event: 'exit', fn: () => void): unknown
  kill(): boolean
}

export interface LookerOptions {
  start: () => HelperProcess
  /** How long ONE path may take to be looked at. */
  lookMs: number
  readMs: number
  /** The helper is ended after this long with nothing asked; it is started again when needed. */
  idleMs: number
  /** Helpers ended for not answering, within `stallWindowMs`, before no more are started for a while. */
  stallsMax?: number
  stallWindowMs?: number
  log?: (line: string) => void
}

/** A read that got no answer (its disk did not answer, or there was no helper to ask). */
export const UNANSWERED = 'unanswered' as const
/** After this many paths in one batch have gone unanswered, the rest are not asked about. */
const STALLS_PER_BATCH = 2
/** Helpers ended for not answering, within STALL_WINDOW_MS, before no more are started for a
 *  while: a helper stuck on a dead disk may not go away when ended, and a loop handing over
 *  such paths must not be able to leave a pile of them. */
const STALLS_MAX = 4
const STALL_WINDOW_MS = 60_000

const slow = (path: string): OfferStat => ({ path, real: '', kind: 'slow', size: 0, inProfile: false, homeRel: null, ident: '' })

export function createLooker(o: LookerOptions) {
  let helper: HelperProcess | null = null
  let idle: NodeJS.Timeout | null = null
  let n = 0
  /** The question being answered: how its parts are taken, and how it is given up on. */
  let current: { n: number; take: (a: LookAnswer) => void; fail: () => void } | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let stopped = false
  let stalls: number[] = []

  function end(why: string): void {
    const h = helper
    helper = null
    if (idle) clearTimeout(idle)
    idle = null
    if (!h) return
    o.log?.(`[os-entry] helper ended: ${why}`)
    try {
      h.kill()
    } catch {
      /* already gone */
    }
  }

  function ensure(): HelperProcess {
    if (helper) return helper
    if (stopped) throw new Error('Beacon is quitting')
    stalls = stalls.filter((t) => Date.now() - t < (o.stallWindowMs ?? STALL_WINDOW_MS))
    if (stalls.length >= (o.stallsMax ?? STALLS_MAX)) throw new Error('too many helpers have stopped answering')
    const h = o.start()
    helper = h
    h.on('message', (a) => {
      // Only the helper in use, and only the question in hand: a late answer is for nobody.
      if (h === helper && current && a && a.n === current.n) current.take(a)
    })
    h.on('exit', () => {
      if (h !== helper) return
      helper = null
      current?.fail() // it went away mid-question: the question has no answer
    })
    return h
  }

  /** One question at a time. `run` posts it and settles through `finish`, once. */
  function ask<T>(ms: number, make: (num: number) => LookAsk, onPart: (a: LookAnswer, finish: (v: T) => void, more: () => void) => void, unanswered: () => T): Promise<T> {
    const turn = chain.then(
      () =>
        new Promise<T>((resolve) => {
          const num = ++n
          if (idle) clearTimeout(idle)
          idle = null
          let settled = false
          const finish = (v: T): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            current = null
            if (helper) idle = setTimeout(() => end('idle'), o.idleMs)
            resolve(v)
          }
          const expired = (): void => {
            stalls.push(Date.now())
            end('no answer in time')
            finish(unanswered())
          }
          // The clock starts when the question is put, not when it was queued, and `more` starts
          // it again: a question with several parts gets its time for each part.
          let timer = setTimeout(expired, ms)
          const more = (): void => {
            if (settled) return
            clearTimeout(timer)
            timer = setTimeout(expired, ms)
          }
          current = { n: num, take: (a) => onPart(a, finish, more), fail: () => finish(unanswered()) }
          try {
            ensure().postMessage(make(num))
          } catch (e) {
            o.log?.(`[os-entry] not asked: ${e instanceof Error ? e.message : 'no helper'}`)
            end('could not be asked')
            finish(unanswered())
          }
        })
    )
    chain = turn.catch(() => undefined)
    return turn
  }

  /** One go at a list of paths: what was answered, in place; undefined where nothing was. */
  function lookOnce(paths: string[], dirs: LookDirs): Promise<(OfferStat | undefined)[]> {
    const got: (OfferStat | undefined)[] = paths.map(() => undefined)
    return ask<(OfferStat | undefined)[]>(
      o.lookMs,
      (num) => ({ n: num, ask: 'look', paths, dirs }),
      (a, finish, more) => {
        if ('stat' in a) {
          // Kept only for the path that was asked about, in its place.
          if (Number.isInteger(a.at) && a.at >= 0 && a.at < paths.length && a.stat?.path === paths[a.at]) {
            got[a.at] = a.stat
            more()
          }
        } else if ('done' in a) finish(got)
      },
      () => got
    )
  }

  return {
    /**
     * What is known about each path, in order. Each path has `lookMs` to be answered. One that is
     * not is 'slow', and the paths after it are asked about again without it (a file on a dead
     * disk must not take the healthy files handed over with it down too). After the second such
     * path in one batch the rest are 'slow' unasked, so a batch cannot wait without end.
     */
    async look(paths: string[], dirs: LookDirs): Promise<OfferStat[]> {
      const out: OfferStat[] = paths.map(slow)
      let from = 0
      for (let stalled = 0; from < paths.length && stalled < STALLS_PER_BATCH; stalled++) {
        const got = await lookOnce(paths.slice(from), dirs)
        // The helper answers in order, so what it answered is the front of the list.
        let k = 0
        while (k < got.length && got[k] !== undefined) {
          out[from + k] = got[k] as OfferStat
          k++
        }
        from += k + 1 // past the one that was not answered
      }
      return out
    },
    /** One file's bytes; null when it changed or cannot be read; UNANSWERED when its disk did not answer. */
    read(file: { real: string; ident: string; size: number }, max: number): Promise<Uint8Array | null | typeof UNANSWERED> {
      return ask<Uint8Array | null | typeof UNANSWERED>(
        o.readMs,
        (num) => ({ n: num, ask: 'read', file, max }),
        (a, finish) => {
          if ('bytes' in a) finish(a.bytes instanceof Uint8Array && a.bytes.byteLength === file.size ? a.bytes : null)
        },
        () => UNANSWERED
      )
    },
    /** Beacon is quitting: the helper is ended, a question in hand is given up, none is started. */
    stop: (): void => {
      stopped = true
      end('Beacon is quitting')
      current?.fail()
    },
    /** For the checks: whether a helper is up right now. */
    running: (): boolean => helper !== null
  }
}
export type Looker = ReturnType<typeof createLooker>
