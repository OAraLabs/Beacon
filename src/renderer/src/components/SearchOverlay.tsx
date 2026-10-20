import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  EMPTY_RESULTS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY,
  isCurrentResponse,
  isSearchable,
  parseSearchResults,
  searchErrorMessage,
  searchRequestBody,
  segmentSnippet,
  formatHitTime,
  type SearchMessageHit,
  type SearchResults,
  type SearchSummaryHit
} from '@shared/search'
import { sourceLabel, sourceOfSessionId } from '@shared/session-sources'

// Global conversation search (frozen spec: beacon-search-spec.md v2, §3). ⌘⇧F — ⌘F is left free
// for a future find-in-conversation. Not a view: NAV_VIEWS is untouched, this is an overlay over
// whatever you were doing, like the palette.
//
// Two buckets, never merged: BM25 rank is per-corpus, so "Messages" and "From compressed history"
// are separate lists in the server's own order. The compressed bucket is not an edge case — 75% of
// the corpus is compacted — which is why a summary hit gets a real peek panel and not a toast.

interface Props {
  /** Seeded from the ⌘K palette's pinned row, so the query survives the hand-off. */
  initialQuery?: string
  onClose: () => void
  /** Message hit → switch session and land on that rowid. */
  onJump: (sessionId: string, messageId: string) => void
  /** Summary hit → open the peek panel (the pane lives outside this overlay). */
  onPeek: (hit: SearchSummaryHit) => void
}

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-palette)' as unknown as number,
  background: 'var(--c-scrim)',
  backdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '10vh'
}
const panel: CSSProperties = {
  width: 'min(720px, 94vw)',
  maxHeight: '74vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line-bright)',
  borderRadius: 12,
  overflow: 'hidden'
}
const input: CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  fontSize: 15,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--c-line)',
  color: 'var(--c-text)',
  outline: 'none'
}
const bucketHead: CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: 'var(--track-caps)',
  color: 'var(--c-text-faint)',
  padding: '10px 16px 4px'
}
const note: CSSProperties = { padding: '28px 16px', textAlign: 'center', color: 'var(--c-text-dim)', fontSize: 13 }

/** ⟦⟧ runs → <mark>. Text nodes, so React escapes; markdown is never invoked on a snippet. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {segmentSnippet(text).map((seg, i) =>
        seg.mark ? (
          <mark key={i} style={{ background: 'var(--c-arc-soft)', color: 'var(--c-text)', borderRadius: 2, padding: '0 1px' }}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

function Row({
  active,
  meta,
  snippet,
  onActivate,
  onHover
}: {
  active: boolean
  meta: string
  snippet: string
  onActivate: () => void
  onHover: () => void
}) {
  return (
    <button
      onClick={onActivate}
      onMouseEnter={onHover}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 16px',
        background: active ? 'var(--c-inset)' : 'transparent',
        border: 'none',
        borderLeft: active ? '2px solid var(--c-arc)' : '2px solid transparent',
        color: 'var(--c-text)',
        cursor: 'pointer',
        font: 'inherit'
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1.45, display: 'block' }}>
        <Snippet text={snippet} />
      </span>
      <span style={{ fontSize: 10, color: 'var(--c-text-faint)', display: 'block', marginTop: 2 }}>{meta}</span>
    </button>
  )
}

export function SearchOverlay({ initialQuery = '', onClose, onJump, onPeek }: Props) {
  const [q, setQ] = useState(initialQuery)
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Monotonic request counter: main owns the fetch, so a stale answer is discarded on arrival
  // rather than aborted at the source. See isCurrentResponse.
  const seqRef = useRef(0)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    if (!isSearchable(q)) {
      seqRef.current++ // invalidate anything in flight — an emptied box must not fill back in
      setResults(EMPTY_RESULTS)
      setError(null)
      setBusy(false)
      return
    }
    const seq = ++seqRef.current
    setBusy(true)
    const timer = setTimeout(() => {
      const b = window.beacon
      if (!b) return
      b.daemon
        .write('/api/search', searchRequestBody(q), 'POST')
        .then((data) => {
          if (!isCurrentResponse(seq, seqRef.current)) return
          setResults(parseSearchResults(data))
          setError(null)
          setBusy(false)
          setSel(0)
        })
        .catch((err) => {
          if (!isCurrentResponse(seq, seqRef.current)) return
          setResults(EMPTY_RESULTS)
          setError(searchErrorMessage(err))
          setBusy(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q])

  // One flat list for keyboard traversal; the BUCKETS stay separate on screen and in rank.
  const flat = useMemo(
    () => [...results.messages, ...results.summaries] as (SearchMessageHit | SearchSummaryHit)[],
    [results]
  )

  const activate = useCallback(
    (hit: SearchMessageHit | SearchSummaryHit) => {
      if (hit.kind === 'message') {
        onJump(hit.sessionId, hit.messageId)
        onClose()
        return
      }
      onPeek(hit)
      onClose()
    },
    [onJump, onPeek, onClose]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, Math.max(0, flat.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(0, s - 1))
      } else if (e.key === 'Enter' && flat[sel]) {
        e.preventDefault()
        activate(flat[sel])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flat, sel, activate, onClose])

  const short = q.trim().length > 0 && !isSearchable(q)

  return (
    <div style={scrim} onClick={onClose} role="dialog" aria-label="Search conversations">
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          style={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          spellCheck={false}
        />
        <div style={{ overflowY: 'auto' }}>
          {error ? (
            <div style={{ ...note, color: 'var(--c-err)' }}>{error}</div>
          ) : short ? (
            <div style={note}>Keep typing — {SEARCH_MIN_QUERY} characters minimum.</div>
          ) : !isSearchable(q) ? (
            <div style={note}>Search every message and every compressed summary the daemon holds.</div>
          ) : busy ? (
            <div style={note}>Searching…</div>
          ) : flat.length === 0 ? (
            <div style={note}>No matches for “{q.trim()}”.</div>
          ) : (
            <>
              {results.messages.length > 0 ? (
                <>
                  <div style={bucketHead}>Messages · {results.messages.length}</div>
                  {results.messages.map((hit, i) => (
                    <Row
                      key={`${hit.sessionId}:${hit.messageId}`}
                      active={sel === i}
                      snippet={hit.snippet}
                      meta={`${sourceLabel(sourceOfSessionId(hit.sessionId))} · ${hit.role} · ${formatHitTime(hit.ts)}`}
                      onActivate={() => activate(hit)}
                      onHover={() => setSel(i)}
                    />
                  ))}
                </>
              ) : null}
              {results.summaries.length > 0 ? (
                <>
                  <div style={bucketHead}>From compressed history · {results.summaries.length}</div>
                  {results.summaries.map((hit, i) => {
                    const idx = results.messages.length + i
                    return (
                      <Row
                        key={hit.summaryId || `${hit.sessionId}:${idx}`}
                        active={sel === idx}
                        snippet={hit.snippet}
                        meta={`${sourceLabel(sourceOfSessionId(hit.sessionId))} · covers ${hit.anchorMessageIds.length} message${
                          hit.anchorMessageIds.length === 1 ? '' : 's'
                        } · ${formatHitTime(hit.ts)}`}
                        onActivate={() => activate(hit)}
                        onHover={() => setSel(idx)}
                      />
                    )
                  })}
                </>
              ) : null}
            </>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 14,
            padding: '7px 16px',
            borderTop: '1px solid var(--c-line)',
            fontSize: 10,
            color: 'var(--c-text-faint)'
          }}
        >
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span style={{ marginLeft: 'auto' }}>{results.returned > 0 ? `${results.returned} hits` : ''}</span>
        </div>
      </div>
    </div>
  )
}

/** Re-exported so MainView can type its peek handler without importing the shared module twice. */
export type { SearchSummaryHit }
