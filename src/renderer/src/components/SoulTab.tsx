import { useCallback, useEffect, useState } from 'react'
import { SOUL_PATH, parseSoul, soulEdited, soulEmptyLine, soulFromError, soulSentence, soulShown, soulSize, type SoulAnswer } from '@shared/soul'

/**
 * Soul: the persona (SOUL.md) Prometheus puts into every prompt. Read-only: there is no write route.
 * It asks for itself, so a statement the daemon makes about the file (missing, a link, too large,
 * unreadable, no such route) is shown as a plain sentence and not swallowed as "no data".
 * The text is shown as TEXT, never as markup: these are the agent's own instructions.
 */
export function SoulTab() {
  const [answer, setAnswer] = useState<SoulAnswer | null>(null)
  const load = useCallback((): (() => void) => {
    let alive = true
    const b = window.beacon
    if (!b) {
      setAnswer({ kind: 'failed' })
      return () => undefined
    }
    void b.daemon.get(SOUL_PATH).then(
      (body) => alive && setAnswer(parseSoul(body)),
      (e) => alive && setAnswer(soulFromError(e))
    )
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => load(), [load])
  if (!answer) return <div style={{ color: 'var(--c-text-dim)', fontSize: 13 }}>Loading…</div>
  const sentence = soulSentence(answer)
  if (answer.kind !== 'document') {
    return (
      <div data-testid="soul-statement" style={{ maxWidth: 560, color: 'var(--c-text-dim)', fontSize: 13, lineHeight: 1.5 }}>
        {sentence}
        {answer.kind === 'failed' ? (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => {
                setAnswer(null)
                load()
              }}
              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    )
  }
  const d = answer.document
  const empty = soulEmptyLine(d)
  const shown = soulShown(d)
  return (
    <div data-testid="soul" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--c-text-faint)' }}>Persona</span>
        <span data-testid="soul-size" style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
          {soulSize(d.bytes)}
        </span>
      </div>
      <div data-testid="soul-edited" style={{ fontSize: 12, color: 'var(--c-text-dim)', marginBottom: 10 }}>
        {soulEdited(d.modifiedAt)}. This is the file Prometheus puts into every prompt.
      </div>
      {empty ? (
        <div data-testid="soul-empty" style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--c-text-faint)' }}>
          {empty}
        </div>
      ) : (
        <>
          <pre
            data-testid="soul-text"
            style={{ margin: 0, padding: 12, borderRadius: 8, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', fontFamily: 'var(--font-mono, ui-monospace, Menlo, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}
          >
            {shown.text}
          </pre>
          {shown.note ? <div style={{ fontSize: 12, color: 'var(--c-text-dim)', marginTop: 6 }}>{shown.note}</div> : null}
        </>
      )}
      <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--c-text-faint)', marginTop: 10 }}>Read-only.</div>
    </div>
  )
}
