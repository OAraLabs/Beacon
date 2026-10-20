import { useEffect, useState } from 'react'
import type { PreviewTarget } from '@shared/preview'
import { durationCell, fmtDuration } from '@shared/timeline'
import { barGeometry, callReadout, callStatus, formatArgs, outputLines, runSpan } from '@shared/run-inspector'

// The run inspector (match spec, step 13) — the dock's third pane, ⌘1.
//
// Opened by the header segment or by clicking any row in a tool run card, which selects THAT call.
// Three tabs over one run: what it printed, what it was asked, and how the calls sat against each
// other in time. The third is the one you cannot get from the transcript.

type Tab = 'output' | 'args' | 'timeline'
const TABS: { id: Tab; label: string }[] = [
  { id: 'output', label: 'Output' },
  { id: 'args', label: 'Args' },
  { id: 'timeline', label: 'Timeline' }
]

export function RunInspector({ target }: { target: Extract<PreviewTarget, { kind: 'run' }> }) {
  const [tab, setTab] = useState<Tab>('output')
  // The host the run happened on — one of the COST rows that can actually be sourced.
  const [gateway, setGateway] = useState<string | null>(null)
  useEffect(() => {
    void window.beacon?.connection
      .status()
      .then((s) => setGateway(s.gateway ?? null))
      .catch(() => undefined)
  }, [])
  const [selected, setSelected] = useState(target.selected)
  const call = target.calls.find((c) => c.callId === selected) ?? target.calls[0]
  const span = runSpan(target.calls)
  if (!call) return null

  return (
    <div className="run-inspector">
      <div className="run-tabs" role="tablist" aria-label="Run inspector">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`run-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* The selected call, above whichever tab is showing — so switching tabs never leaves you
          wondering which call you are looking at. */}
      <div className="run-selected">
        <span className={`run-dot is-${callStatus(call)}`} aria-hidden />
        <span className="run-name">{call.name}</span>
        <span className="run-readout">{callReadout(call, fmtDuration)}</span>
      </div>

      <div className="run-body">
        {tab === 'output' ? (
          <pre className="run-inset">
            {call.result
              ? outputLines(call.result).map((l, i) => (
                  <span key={i} className={l.bad ? 'run-line is-bad' : 'run-line'}>
                    {l.text}
                    {'\n'}
                  </span>
                ))
              : call.running
                ? 'still running…'
                : 'no output'}
          </pre>
        ) : null}

        {tab === 'args' ? <pre className="run-inset">{formatArgs(call.args)}</pre> : null}

        {tab === 'timeline' ? (
          <div className="run-timeline">
            {target.calls.map((c) => {
              const geo = barGeometry(c, span)
              return (
                <button
                  key={c.callId}
                  className={`run-trow${c.callId === call.callId ? ' is-active' : ''}`}
                  onClick={() => setSelected(c.callId)}
                >
                  <span className="run-tname">{c.name}</span>
                  <span className="run-track">
                    {/* No bar when nothing timestamped this call. A history row carries no clock,
                        and drawing a full-width bar for it would claim it took the whole run. */}
                    {geo ? (
                      <span
                        className={`run-bar is-${callStatus(c)}`}
                        style={{ left: `${geo.offsetPct}%`, width: `${geo.widthPct}%` }}
                      />
                    ) : null}
                  </span>
                  {durationCell(c) !== null ? <span className="run-tdur">{durationCell(c)}</span> : null}
                </button>
              )
            })}
            {span.totalMs === null ? (
              <div className="run-note">
                No timings on these rows — they came from history, which stores the calls but not
                their clocks. A live run draws its bars.
              </div>
            ) : null}
          </div>
        ) : null}

        {/* COST. Two rows, not four: the spec asks for tokens in and tokens out as well, and
            nothing on this wire reports per-run token accounting — the daemon's usage is
            per-session context, a different quantity. Rows that cannot be sourced are absent
            rather than dashed. */}
        <div className="run-cost">
          <div className="run-cost-cap">COST</div>
          <div className="run-cost-row">
            <span>wall time</span>
            <span>{span.totalMs === null ? 'unknown' : fmtDuration(span.totalMs)}</span>
          </div>
          <div className="run-cost-row">
            <span>host</span>
            <span>{gateway || 'unknown'}</span>
          </div>
          <div className="run-cost-row">
            <span>calls</span>
            <span>{target.calls.length}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
