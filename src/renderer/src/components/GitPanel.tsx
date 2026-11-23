import { useCallback, useEffect, useRef, useState } from 'react'
import { diffLineTone } from '@shared/coding'
import type { GitDetail, GitDiff, GitDiffMode } from '@shared/git-state'
import { gitEmptyWords, gitGroups, gitMoreWords, prStateWords } from '@shared/git-view'
import type { GitPr } from '@shared/git-pr'
import { GIT_ACTIONS_NOTE, type GitAction } from '@shared/git-actions'
import { diffLineShown, gitText } from '@shared/git-state'

/**
 * The Git panel under the header's branch chip: the changed files, each opening its diff, and
 * the commits this branch has that its upstream lacks. Read-only. Everything shown is text git
 * printed about the conversation's own folder; nothing here runs, stages or commits anything.
 */
export function GitPanel({ sessionId, words, refreshKey, place, pr, actions, onAsk }: { sessionId: string; words: string; refreshKey?: unknown; place: { left: number; width: number; maxHeight: number }; pr: GitPr | null; actions: GitAction[]; onAsk?: (prompt: string) => void }) {
  const [detail, setDetail] = useState<GitDetail | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitDiff>>({})
  const live = useRef(true)
  /** Each read of the list is numbered: an answer that is not the latest asked for is dropped. */
  const seq = useRef(0)
  /** Diffs with main now: one question per file at a time, however often its row is pressed. */
  const asking = useRef(new Set<string>())
  const openRef = useRef<string | null>(null)
  openRef.current = openKey
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  /** Ask for one diff. What is shown for it stays until the new answer lands. */
  const ask = useCallback(
    (key: string) => {
      const b = window.beacon
      if (!b || asking.current.has(key)) return
      const cut = key.indexOf('\n')
      const mode = key.slice(0, cut) as GitDiffMode
      const path = key.slice(cut + 1)
      asking.current.add(key)
      void b.git
        .diff(sessionId, path, mode)
        .then(
          (d) => live.current && setDiffs((m) => ({ ...m, [key]: d })),
          () => live.current && setDiffs((m) => ({ ...m, [key]: { kind: 'unreadable', why: 'Beacon could not ask for this just now.' } }))
        )
        .finally(() => asking.current.delete(key))
    },
    [sessionId]
  )
  const load = useCallback(() => {
    const b = window.beacon
    if (!b) return
    const mine = ++seq.current
    void b.git.detail(sessionId).then(
      (d) => {
        if (!live.current || mine !== seq.current) return
        setDetail(d)
        // The files may have changed: the diff that is open is asked for again (and stays as it is until then).
        if (openRef.current) ask(openRef.current)
      },
      () => live.current && mine === seq.current && setDetail({ kind: 'unreadable', why: 'Beacon could not ask for this just now.' })
    )
  }, [sessionId, ask])
  useEffect(() => {
    load()
  }, [load, refreshKey])
  // While the panel is open and showing, it is read again every few seconds: the same file edited
  // twice changes nothing the chip says, and the diff on screen should still be the current one.
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    const timer = window.setInterval(again, 6000)
    return () => window.clearInterval(timer)
  }, [load])

  const toggle = (path: string, mode: GitDiffMode): void => {
    const key = `${mode}\n${path}`
    if (openKey === key) return setOpenKey(null)
    setOpenKey(key)
    ask(key) // always: what was read before may be out of date
  }

  const groups = detail?.kind === 'detail' ? gitGroups(detail.entries) : []
  const empty = detail ? gitEmptyWords(detail) : ''
  return (
    <div className="git-panel" role="dialog" aria-label="Git" data-testid="git-panel" style={{ left: place.left, width: place.width, maxHeight: place.maxHeight }}>
      <div className="git-panel-head">{words}</div>
      {pr ? (
        // Opens in the browser: main lets a window open only an https address, and this one is
        // built from the repository's name and the number, never taken from an answer.
        <a className={`git-pr-link is-${pr.state}`} href={pr.url} target="_blank" rel="noreferrer" data-testid="git-pr-link">
          {`Pull request #${pr.number}`}
          <span className="git-pr-link-what">{prStateWords(pr)}</span>
        </a>
      ) : null}
      {onAsk && actions.length > 0 ? (
        // These do no git. Each puts a prepared request in the message box (@shared/git-actions).
        <section className="git-actions" aria-label="Ask your assistant">
          <h3 className="git-group-title">Ask your assistant to</h3>
          <div className="git-action-row">
            {actions.map((a) => (
              <button key={a.id} className="git-action" onClick={() => onAsk(a.prompt)} title={a.hint} data-testid="git-action" data-action={a.id}>
                {a.label}
              </button>
            ))}
          </div>
          <div className="git-panel-note">{GIT_ACTIONS_NOTE}</div>
        </section>
      ) : null}
      {detail === null ? <div className="git-panel-note">Reading…</div> : null}
      {empty ? (
        <div className="git-panel-note" data-testid="git-panel-empty">
          {empty}
        </div>
      ) : null}
      {groups.map((g) => (
        <section key={g.title} className="git-group" aria-label={g.title}>
          <h3 className="git-group-title">
            {g.title} <span className="git-group-count">{g.rows.length}</span>
          </h3>
          <ul className="git-files">
            {g.rows.map((r) => {
              const key = r.mode ? `${r.mode}\n${r.path}` : null
              const open = key !== null && openKey === key
              const d = key ? diffs[key] : undefined
              return (
                <li key={`${g.title}\n${r.path}`}>
                  {r.mode ? (
                    <button className="git-file" aria-expanded={open} onClick={() => toggle(r.path, r.mode as GitDiffMode)} data-testid="git-file" data-path={r.shown}>
                      <span className="git-file-name">{r.shown}</span>
                      <span className="git-file-what">{r.what}</span>
                    </button>
                  ) : (
                    <div className="git-file is-plain" data-testid="git-file" data-path={r.shown}>
                      <span className="git-file-name">{r.shown}</span>
                      <span className="git-file-what">{r.what}</span>
                    </div>
                  )}
                  {open ? <DiffBlock diff={d} /> : null}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {detail?.kind === 'detail' && detail.more > 0 ? <div className="git-panel-note">{gitMoreWords(detail.more)}</div> : null}
      {detail?.kind === 'detail' && detail.commits.length > 0 ? (
        <section className="git-group" aria-label="Not yet upstream">
          <h3 className="git-group-title">
            Not yet upstream <span className="git-group-count">{detail.commits.length}</span>
          </h3>
          <ul className="git-commits">
            {detail.commits.map((c) => (
              <li key={c.hash} className="git-commit" data-testid="git-commit">
                <code>{c.hash}</code>
                <span>{gitText(c.subject, 120)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** The colour class for one diff line. A conflicted file's diff is a COMBINED one (`diff --cc`,
 *  `@@@`): each line has two sign columns, one per side, and a line added or removed on either
 *  side is told by either column. */
function lineTone(line: string, combined: boolean): string {
  if (!combined || line.startsWith('@@@') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return line.startsWith('@@@') ? 'hunk' : diffLineTone(line)
  const two = line.slice(0, 2)
  if (two.includes('+')) return 'add'
  if (two.includes('-')) return 'del'
  return 'context'
}

function DiffBlock({ diff }: { diff: GitDiff | undefined }) {
  if (!diff) return <div className="git-panel-note">Reading…</div>
  if (diff.kind === 'none') return <div className="git-panel-note">This file is no longer changed that way.</div>
  if (diff.kind === 'unreadable') return <div className="git-panel-note">{diff.why}</div>
  // The diff is TEXT: each line is a text node, never markup, whatever the file holds.
  const lines = diff.text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const combined = lines.some((l) => l.startsWith('diff --cc ') || l.startsWith('diff --combined ') || l.startsWith('@@@'))
  return (
    <div className="git-diff" data-testid="git-diff">
      <pre>
        {lines.map((line, i) => (
          <span key={i} className={`git-diff-line is-${lineTone(line, combined)}`}>
            {line === '' ? ' ' : diffLineShown(line)}
            {'\n'}
          </span>
        ))}
      </pre>
      {diff.truncated ? <div className="git-panel-note">The rest of this change is not shown.</div> : null}
    </div>
  )
}
