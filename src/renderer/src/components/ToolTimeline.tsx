import { useEffect, useState } from 'react'
import {
  argSummary,
  durationCell,
  fmtDuration,
  hasLiveCall,
  ranLabel,
  resultSummary,
  runDuration,
  stripOpen,
  toolTally,
  type TimelineCall
} from '@shared/timeline'
import { usePreview } from '../preview-store'
import { Icon } from './Icon'

// The TOOL RUN CARD (match spec). ONE collapsible card, not a header above a row of pills.
//
// What it replaced carried less information than the row it occupied: `⚡ 1 CALL` stacked over a
// bare `bash` chip — no arguments, no duration, no result, nothing to click. The run was less
// legible than the raw transcript.
//
// Now: a summary row (status, `Ran 2 tools`, which tools, total duration, chevron) over one row
// per call (status dot, name, argument summary, duration, result). Every call row opens the run
// inspector ON THAT CALL — which is what the inspector was built for.
//
// Used by the chat stream (live, with timestamps) and by history rows (content_json parts, no
// timestamps → durations from the daemon's own per-call figures).





// `previewBody` is gone with the plain-text preview it fed: args and output are now two TABS in
// the run inspector rather than one concatenated blob, so nothing needs to flatten them.



/** Fast enough that the tenths in `fmtDuration` actually move; slow enough to be free. */
const TICK_MS = 200

/**
 * Wall clock for a strip with work in flight, so the header duration counts up instead of
 * freezing at the last finished call. Returns undefined — and holds no interval — the moment
 * nothing is running, so a finished strip and a history strip both cost nothing.
 */
function useLiveClock(active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [active])
  return active ? now : undefined
}

export function ToolTimeline({ calls }: { calls: TimelineCall[] }) {
  // null until the reader clicks — until then the card decides for itself, EVERY render, so a
  // live run folds once it crosses COLLAPSE_ABOVE instead of being judged at its first call.
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const { open: openInspector } = usePreview()
  const now = useLiveClock(hasLiveCall(calls))
  if (calls.length === 0) return null
  const open = stripOpen(calls.length, userChoice)
  const total = runDuration(calls)
  const anyError = calls.some((c) => c.error)
  const anyRunning = calls.some((c) => c.running)

  return (
    <div className="run-card" aria-label="Tool activity">
      {/* SUMMARY ROW. One line that says what happened: a status glyph, how many tools ran,
          which ones, and how long it took. The old header said `⚡ 1 CALL` above a bare pill —
          two stacked rows carrying less than this one does. */}
      <button
        className="run-card-head"
        onClick={() => setUserChoice(!open)}
        aria-expanded={open}
        title={open ? 'Collapse the run' : 'Show every call'}
      >
        <span
          className={`run-card-glyph is-${anyRunning ? 'running' : anyError ? 'error' : 'ok'}`}
          aria-hidden
        />
        <span className="run-card-ran">{ranLabel(calls)}</span>
        {/* The tool NAMES, deduped and in order — the single most useful thing about a collapsed
            run, and what the old tally row was for. */}
        <span className="run-card-tools">{toolTally(calls).map((t) => t.name + (t.count > 1 ? `×${t.count}` : '')).join(' · ')}</span>
        {/* The total ONLY when there is one. History rows carry no clocks, and an empty cell where
            a number belongs looks like a failed load — the `— tools` lesson again. */}
        {(() => {
          const text = anyRunning ? fmtDuration(elapsed(calls, now)) : fmtDuration(total)
          return text ? <span className="run-card-dur">{text}</span> : null
        })()}
        <span className={`run-card-chev${open ? ' is-open' : ''}`} aria-hidden>
          <Icon name="chevron-down" size={11} />
        </span>
      </button>

      {/* CALL ROWS. One per call, and each one OPENS THE INSPECTOR on itself — which is the
          whole reason the inspector exists and what the bare pill had no way to do. */}
      {open
        ? calls.map((c) => (
            <button
              key={c.callId}
              className="run-call"
              onClick={() => openInspector({ kind: 'run', title: 'Run inspector', calls, selected: c.callId })}
              title={`${c.name} — open in the run inspector`}
            >
              <span className={`run-call-dot is-${c.running ? 'running' : c.error ? 'error' : 'ok'}`} aria-hidden />
              <span className="run-call-name">{c.name}</span>
              <span className="run-call-args">{argSummary(c.args)}</span>
              {durationCell(c) !== null ? <span className="run-call-dur">{durationCell(c)}</span> : null}
              <span className={`run-call-result${c.error ? ' is-error' : ''}`}>{resultSummary(c)}</span>
            </button>
          ))
        : null}
    </div>
  )
}

/** Elapsed so far for a run with something still in flight, so the header counts up. */
function elapsed(calls: TimelineCall[], now?: number): number | undefined {
  if (now === undefined) return undefined
  let start: number | undefined
  for (const c of calls) if (typeof c.startTs === 'number') start = start === undefined ? c.startTs : Math.min(start, c.startTs)
  return start === undefined ? undefined : Math.max(0, now - start)
}
