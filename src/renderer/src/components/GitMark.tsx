import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gitChip, gitMark, type GitMarkKind } from '@shared/git-view'
import { useGit } from '../git-store'
import { GitPanel } from './GitPanel'
import { Icon, type IconName } from './Icon'

const GLYPH: Record<GitMarkKind, IconName> = { branch: 'git-branch', changes: 'git-branch', moved: 'git-moved', alert: 'git-alert' }

/**
 * The git mark on a conversation's row in the session list: a glyph, and the number of changed
 * files when there are any. Reads only while the row is on screen. Nothing at all when the
 * conversation's folder is not a repository, or Prometheus is on another computer.
 */
export function GitMark({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { rootMargin: '120px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const mark = gitMark(useGit(sessionId, { watch: seen }))
  return (
    <span ref={ref} className={`git-mark${mark ? ` is-${mark.kind}` : ' is-empty'}`} title={mark?.words} aria-label={mark?.words} role={mark ? 'img' : undefined} data-testid="git-mark" data-kind={mark?.kind ?? 'none'}>
      {mark ? (
        <>
          <Icon name={GLYPH[mark.kind]} size={12} />
          {mark.count ? <span className="git-mark-count">{mark.count}</span> : null}
        </>
      ) : null}
    </span>
  )
}

/**
 * The branch chip in a conversation's header, beside its folder: the branch, changed files, and
 * how far it is from its upstream. Read more often than a row, and again when a turn ends. Click
 * it for the Git panel (the changed files, their diffs, the commits not yet upstream).
 */
export function GitChip({ sessionId, refreshKey }: { sessionId: string; refreshKey?: unknown }) {
  const chip = gitChip(useGit(sessionId, { watch: true, open: true, refreshKey }))
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  // Another conversation: its panel starts closed.
  useEffect(() => setOpen(false), [sessionId])
  // Esc and a click outside close the panel; focus goes back to the chip.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open])
  // Where the panel goes: under the chip, its right edge on the chip's, but never outside the
  // conversation's header (the pane clips what leaves it, and the chip can be anywhere in a
  // wrapping row). Worked out when it opens and when the window changes size.
  const [place, setPlace] = useState<{ left: number; width: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return setPlace(null)
    const fit = (): void => {
      const wrap = root.current?.getBoundingClientRect()
      const head = root.current?.closest('.thread-head')?.getBoundingClientRect()
      if (!wrap || !head) return setPlace(null)
      const room = Math.max(0, head.width - 24)
      const width = Math.min(560, room)
      const left = Math.min(Math.max(wrap.right - width, head.left + 12), head.right - 12 - width)
      // And never past the bottom of the window: it scrolls inside itself.
      setPlace({ left: left - wrap.left, width, maxHeight: Math.max(160, Math.min(640, window.innerHeight - wrap.bottom - 18)) })
    }
    fit()
    window.addEventListener('resize', fit)
    // The header changes width without the window doing so (a pane opened beside it, the chip's own text).
    const head = root.current?.closest('.thread-head')
    const ro = typeof ResizeObserver !== 'undefined' && head ? new ResizeObserver(fit) : null
    if (ro && head) ro.observe(head)
    return () => {
      window.removeEventListener('resize', fit)
      ro?.disconnect()
    }
  }, [open])
  // No chip any more (the folder is no longer a repository, another Prometheus): the panel is closed, not waiting to reopen.
  const has = chip !== null
  useEffect(() => {
    if (!has) setOpen(false)
  }, [has])
  if (!chip) return null
  return (
    <div className="git-chip-wrap" ref={root}>
      <button ref={button} className={`git-chip is-${chip.kind}`} title={chip.words} aria-label={`${chip.words}. Show the changed files.`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="git-chip" data-kind={chip.kind}>
        <Icon name={GLYPH[chip.kind]} size={13} />
        <span className="git-chip-head">{chip.head}</span>
        {chip.count ? <span className="git-chip-count">{chip.count}</span> : null}
        {chip.ahead > 0 ? <span className="git-chip-move">↑{chip.ahead}</span> : null}
        {chip.behind > 0 ? <span className="git-chip-move">↓{chip.behind}</span> : null}
      </button>
      {open && place ? <GitPanel sessionId={sessionId} words={chip.words} refreshKey={`${String(refreshKey)}:${chip.words}`} place={place} /> : null}
    </div>
  )
}
