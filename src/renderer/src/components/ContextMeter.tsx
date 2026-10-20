import { useEffect, useState, type CSSProperties } from 'react'
import { contextUsage, fmtTokens, isAuthError, segmentsAreLegible, type LcmStateDTO } from '@shared/daemon-api'

// Context-window meter. Design handoff 2026-09-03, screen 3: it lives in the SESSIONS PANEL's
// footer (`variant="footer"`: `5.3k / 33k ctx` · `16%` over a 3px bar) — the original put
// `5.3k/33k · 16% CTX` at 9px in the far bottom-left corner of the window, the least-looked-at
// pixel in a desktop app for a number that decides whether the next message fits. The vertical
// `rail` variant is kept for any 60px column that wants it. Click opens Status, where the full
// breakdown (fresh / summaries / compression / source) already lives — this is the glance, that
// is the detail.
//
// ⚠ UNKNOWN IS RENDERED, NOT ROUNDED TO ZERO. The daemon can legitimately answer
// `limit: null, limit_source: "unknown"` or `assembled: false`. Painting either as an empty
// 0% bar would read as "plenty of headroom" — the exact fabricated-denominator failure the
// daemon side was just fixed to stop doing. See contextUsage().

const POLL_MS = 8000 // slower than Status' 4s: this is ambient, not a live inspector

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  width: '100%',
  padding: '6px 4px',
  borderRadius: 8,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-dim)',
  cursor: 'pointer',
  font: 'inherit'
}
const track: CSSProperties = {
  width: '100%',
  height: 4,
  borderRadius: 2,
  background: 'var(--c-inset)',
  overflow: 'hidden'
}
const caption: CSSProperties = {
  fontSize: 9,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: 'var(--c-text-faint)'
}
const readout: CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--c-text-dim)',
  lineHeight: 1
}

/** Fill colour by pressure — matches StatusPanel's thresholds so the two agree. */
const fillColor = (pct: number): string =>
  pct > 90 ? 'var(--c-err)' : pct > 70 ? 'var(--c-warn)' : 'var(--c-ok)'

// Segment colours are CATEGORY, not pressure: summaries are compacted history,
// fresh is the live tail. Pressure still governs the unsegmented fill, so the
// bar never loses the "you are nearly full" signal — at >90% the segments are
// dropped in favour of the single red fill, because at that point WHICH KIND of
// tokens are filling it matters less than the fact that it is filling.
const SEGMENT_PRESSURE_CUTOFF = 90

// The drawable width inside the rail: 66px rail - the wrap's 4px side padding.
// A constant rather than a measurement because the rail is a fixed-width column;
// if that ever changes, this is the one number to change with it.
const RAIL_TRACK_PX = 58
/** The sessions panel is 264px; its footer pads 12px a side. */
const FOOTER_TRACK_PX = 240
/** The composer's meter is the handoff's 34px — too narrow to segment, so it never tries. */
const COMPOSER_TRACK_PX = 34

export function ContextMeter({
  sessionId,
  onOpen,
  variant = 'rail'
}: {
  sessionId: string
  onOpen: () => void
  /** `footer`: readout + 3px bar (the sessions panel, screen 3). `composer`: the compact
   *  `5.3k/33k` + 34px meter at the right of the composer's control row (screen 1) — the reading
   *  at the moment of sending, which is when "will the next message fit" is the live question.
   *  `rail`: the original vertical idiom, kept for any narrow column that wants it. */
  variant?: 'rail' | 'footer' | 'composer'
}) {
  const [lcm, setLcm] = useState<LcmStateDTO | null>(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    const b = window.beacon
    if (!b || !sessionId) {
      setLcm(null)
      return
    }
    let alive = true
    const poll = (): void => {
      void b.daemon
        .get(`/api/lcm/${encodeURIComponent(sessionId)}`)
        .then((d) => {
          if (!alive) return
          setLcm(d as LcmStateDTO)
          setDenied(false)
        })
        .catch((e) => {
          // A 401 must not render as 0% — that is a reading, and we have none.
          if (alive && isAuthError(e)) {
            setDenied(true)
            setLcm(null)
          }
        })
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [sessionId])

  // No session selected — the meter would describe nothing. Render nothing.
  if (!sessionId) return null

  const usage = denied ? ({ kind: 'unknown', reason: 'not authorized' } as const) : contextUsage(lcm)
  const known = usage.kind === 'known'

  // Segment only when BOTH parts would actually paint at this width. On a 58px rail a 1%
  // segment is 0.6px — the browser draws nothing and the bar silently claims the context is
  // all one kind. Falling back to the single fill loses no information: the breakdown is in
  // the tooltip below, and StatusPanel segments the same data on a bar wide enough for it.
  const showSegments =
    known && usage.segments != null && usage.pct <= SEGMENT_PRESSURE_CUTOFF &&
    segmentsAreLegible(usage.segments, variant === 'footer' ? FOOTER_TRACK_PX : variant === 'composer' ? COMPOSER_TRACK_PX : RAIL_TRACK_PX)

  const breakdown =
    known && usage.segments
      ? ` — ${usage.segments.summaryTokens.toLocaleString()} summarised + ${usage.segments.freshTokens.toLocaleString()} fresh`
      : ''
  const title = known
    ? `Context window — ${usage.total.toLocaleString()} / ${usage.limit.toLocaleString()} tokens (${usage.pct}%)${breakdown}, limit ${usage.source}. Click for detail.`
    : `Context window unknown — ${usage.reason}. No denominator resolved, so no percentage is shown. Click for detail.`

  const bar = (
      <div style={variant === 'footer' ? { ...track, height: 3, background: 'var(--line2)' } : track} role="progressbar" aria-valuemin={0} aria-valuemax={100}
           aria-valuenow={known ? usage.pct : undefined}>
        {known && showSegments && usage.segments ? (
          // Two segments against the WINDOW, so together they occupy exactly the
          // width the single fill would. The remainder is real free space.
          <div style={{ display: 'flex', height: '100%' }}>
            <div style={{ width: `${usage.segments.summaryPct}%`, height: '100%', background: 'var(--c-violet)' }} />
            <div style={{ width: `${usage.segments.freshPct}%`, height: '100%', background: fillColor(usage.pct) }} />
          </div>
        ) : known ? (
          <div style={{ width: `${usage.pct}%`, height: '100%', background: fillColor(usage.pct) }} />
        ) : (
          // Deliberately no fill: an empty coloured bar would imply a measured low value.
          // The dashed track reads as "no scale", which is what is true.
          <div style={{ width: '100%', height: '100%', borderTop: '1px dashed var(--c-line)' }} />
        )}
      </div>
  )
  if (variant === 'composer') {
    return (
      <button className="ctx-composer" onClick={onOpen} title={title} aria-label={title} data-testid="ctx-composer">
        <span className="ctx-composer-n">{known ? `${fmtTokens(usage.total)}/${fmtTokens(usage.limit)}` : '— / ?'}</span>
        <span className="ctx-composer-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? usage.pct : undefined}>
          {known ? <span className="ctx-composer-fill" style={{ width: `${usage.pct}%`, background: fillColor(usage.pct) }} /> : null}
        </span>
      </button>
    )
  }
  if (variant === 'footer') {
    return (
      <button className="ctx-footer" onClick={onOpen} title={title} aria-label={title} data-testid="ctx-footer">
        <span className="ctx-footer-row">
          <span>{known ? `${fmtTokens(usage.total)} / ${fmtTokens(usage.limit)} ctx` : 'ctx — / ?'}</span>
          <span>{known ? `${usage.pct}%` : '?'}</span>
        </span>
        {bar}
      </button>
    )
  }
  return (
    <button style={wrap} onClick={onOpen} title={title} aria-label={title}>
      {bar}
      <span style={readout}>
        {known ? `${fmtTokens(usage.total)}/${fmtTokens(usage.limit)}` : '— / ?'}
      </span>
      <span style={caption}>{known ? `${usage.pct}% ctx` : 'ctx ?'}</span>
    </button>
  )
}
