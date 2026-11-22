import { useEffect, useRef, useState } from 'react'
import { gitChip, gitMark, type GitMarkKind } from '@shared/git-view'
import { useGit } from '../git-store'
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
 * how far it is from its upstream. Read more often than a row, and again when a turn ends.
 */
export function GitChip({ sessionId, refreshKey }: { sessionId: string; refreshKey?: unknown }) {
  const chip = gitChip(useGit(sessionId, { watch: true, open: true, refreshKey }))
  if (!chip) return null
  return (
    <span className={`git-chip is-${chip.kind}`} title={chip.words} aria-label={chip.words} role="img" data-testid="git-chip" data-kind={chip.kind}>
      <Icon name={GLYPH[chip.kind]} size={13} />
      <span className="git-chip-head">{chip.head}</span>
      {chip.count ? <span className="git-chip-count">{chip.count}</span> : null}
      {chip.ahead > 0 ? <span className="git-chip-move">↑{chip.ahead}</span> : null}
      {chip.behind > 0 ? <span className="git-chip-move">↓{chip.behind}</span> : null}
    </span>
  )
}
