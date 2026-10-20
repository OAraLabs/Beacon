import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  CODING_TOOL_CAP,
  codingGitCommands,
  codingStateLabel,
  diffLineTone,
  elapsedSeconds,
  reportFromStatus,
  runPhase,
  type CodingDiffResult,
  type CodingRunReport,
  type CodingRunStatus,
  type DiffLineTone
} from '@shared/coding'
import { codingSessionId } from '@shared/loop'
import { isAuthError } from '@shared/daemon-api'
import { useGateway } from '../gateway-store'

// Loop Manager — the live run observer. Reuses the SAME surfaces the Coding panel rides (the
// gateway-store codingRuns stream + the @shared/coding helpers + the /api/code REST routes) WITHOUT
// editing CodingPanel (a contended file). Live per-round progression comes from the WS stream keyed
// by `coding:<id>`; the terminal report rides the managed task's output_tail (polled). Weak-
// Supervised: a STOP button only — no pause/inject affordance anywhere (that's Sprint 2).

const MONO = 'var(--font-mono)'
const card: CSSProperties = { border: '1px solid var(--c-line)', borderRadius: 9, padding: 14, background: 'var(--c-raise)' }
const dim: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 13 }
const mono: CSSProperties = { fontFamily: MONO, fontSize: 12, color: 'var(--c-text)' }
const btn = (tone: 'arc' | 'err' | 'line' = 'line', disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '7px 14px',
  borderRadius: 6,
  cursor: disabled ? 'default' : 'pointer',
  border: `1px solid ${tone === 'err' ? 'var(--c-err)' : tone === 'arc' ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : tone === 'err' ? 'var(--c-err-soft)' : tone === 'arc' ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : tone === 'arc' ? 'var(--c-on-arc)' : tone === 'err' ? 'var(--c-err)' : 'var(--c-text)',
  font: 'inherit',
  fontWeight: 600,
  opacity: disabled ? 0.7 : 1
})

const TONE_COLOR: Record<DiffLineTone, string> = {
  add: 'var(--c-ok)',
  del: 'var(--c-err)',
  hunk: 'var(--c-arc)',
  meta: 'var(--c-text-faint)',
  context: 'var(--c-text-dim)'
}

// Mirrors the daemon's TERMINAL_STATUSES. `blocked` is a SecurityGate refusal — terminal there,
// so a set without it waits forever for an end state that already arrived (Prometheus issue 489).
const TERMINAL = new Set(['completed', 'failed', 'killed', 'blocked'])

/** A stable list key. `roundIndex` restarts at 0 every EPISODE, so it collided across episodes —
 * React then reused a row and the list flickered. `seq` is the daemon's run-monotonic rowid. */
function roundKeyOf(r: { seq: number | null; roundIndex: number }): string {
  return r.seq != null ? `s${r.seq}` : `i${r.roundIndex}`
}

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).catch(() => undefined)
}

export function LoopRunView({ codingId, managedId, onClear }: { codingId: string; managedId: string; onClear: () => void }) {
  const { codingRuns } = useGateway()
  const live = codingRuns[codingSessionId(codingId)]

  const [status, setStatus] = useState<CodingRunStatus | null>(null)
  const [report, setReport] = useState<CodingRunReport | null>(null)
  const [stopping, setStopping] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [diff, setDiff] = useState<CodingDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const terminal = !!report || (status ? TERMINAL.has(status.status) : false)
  const phase = runPhase(status?.status, !!report)

  // Poll the managed task for the terminal report (it rides output_tail). Live per-round detail comes
  // from the WS stream (codingRuns), not this poll. Stops once terminal.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const poll = (): void => {
      void b.daemon
        .get(`/api/code/${encodeURIComponent(managedId)}`)
        .then((s) => {
          if (!alive) return
          const st = s as CodingRunStatus
          setStatus(st)
          const rep = reportFromStatus(st)
          if (rep) setReport(rep)
        })
        .catch((e) => {
          if (!alive) return
          if (isAuthError(e)) setAuthErr(true)
          else setErr('Could not read run status from the daemon.')
        })
    }
    poll()
    const id = setInterval(() => {
      if (alive && !terminal) poll()
    }, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [managedId, terminal])

  const stop = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    setStopping(true)
    setErr(null)
    try {
      await b.daemon.write(`/api/code/${encodeURIComponent(managedId)}/stop`)
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setErr('Stop failed — the daemon rejected it (it may already be finishing).')
    } finally {
      setStopping(false)
    }
  }, [managedId])

  const loadDiff = useCallback(async () => {
    const b = window.beacon
    if (!b) return
    setDiffLoading(true)
    setErr(null)
    try {
      setDiff((await b.daemon.get(`/api/code/${encodeURIComponent(managedId)}/diff`)) as CodingDiffResult)
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setErr('Could not load the artifact diff.')
    } finally {
      setDiffLoading(false)
    }
  }, [managedId])

  const elapsed = elapsedSeconds(status?.started_at, status?.ended_at, Date.now())
  const rounds = live?.rounds ?? []
  const tools = live?.tools ?? []
  const acceptance = live?.acceptance ?? []
  const toolsTruncated = live?.toolsTruncated ?? false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>
            {terminal ? 'Run finished' : phase === 'review' ? 'Wrapping up' : 'Running'}
          </span>
          <span style={{ ...dim, fontFamily: MONO }}>· {elapsed}s · {rounds.length} round{rounds.length === 1 ? '' : 's'}</span>
          <span style={{ flex: 1 }} />
          {!terminal ? (
            <button style={btn('err', stopping)} disabled={stopping} onClick={() => void stop()} title="Terminate this run on the daemon (SIGTERM→SIGKILL)">
              {stopping ? 'Stopping…' : 'Stop run'}
            </button>
          ) : (
            <button style={btn('line')} onClick={onClear}>Done</button>
          )}
        </div>
        <div style={{ ...dim, marginTop: 8 }}>
          branch <code style={{ ...mono, color: 'var(--c-arc)' }}>coding/{codingId}</code> · managed <code style={mono}>{managedId}</code>
        </div>
        {authErr ? (
          <div style={{ marginTop: 8, color: 'var(--c-err)', fontSize: 13 }}>Not authorized — the daemon rejected the request (check the API token in Settings).</div>
        ) : err ? (
          <div style={{ marginTop: 8, color: 'var(--c-err)', fontSize: 13 }}>{err}</div>
        ) : null}
        {live?.streamError ? (
          <div style={{ marginTop: 8, color: 'var(--c-warn)', fontSize: 13 }}>
            Live stream hiccup: {live.streamError} — the run continues; the report still loads on completion.
          </div>
        ) : null}
      </div>

      {/* Live per-round progression (from the WS stream) */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)', marginBottom: 8 }}>Live rounds</div>
        {rounds.length === 0 ? (
          <div style={dim}>
            {terminal ? 'No round events were streamed for this run.' : 'Waiting for the first round to stream…'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
            {rounds.map((r) => {
              // The tools the daemon attributed to THIS round (it commits the round row before the
              // round's tools run, so the attribution is exact, not inferred here).
              const its = tools.filter((t) => t.roundIndex === r.roundIndex)
              const failed = its.filter((t) => !t.success).length
              return (
                <div key={roundKeyOf(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', borderRadius: 4, background: 'var(--c-inset)' }}>
                  <span style={{ ...mono, color: 'var(--c-arc)', minWidth: 38 }}>#{r.roundIndex}</span>
                  <span style={{ fontSize: 12, color: 'var(--c-text)', minWidth: 84 }}>{r.outcome || '—'}</span>
                  {its.length > 0 ? (
                    <span
                      style={{ ...dim, fontSize: 11, color: failed ? 'var(--c-err)' : 'var(--c-text-dim)' }}
                      title={its.map((t) => `${t.success ? '✓' : '✗'} ${t.toolName}${t.latencyMs != null ? ` (${Math.round(t.latencyMs)}ms)` : ''}`).join('\n')}
                    >
                      {its.length} tool{its.length === 1 ? '' : 's'}{failed ? ` · ${failed} failed` : ''}
                    </span>
                  ) : null}
                  <span style={{ ...dim, fontSize: 11 }}>
                    {r.inputTokens != null || r.outputTokens != null ? `${r.inputTokens ?? '?'}→${r.outputTokens ?? '?'} tok` : ''}
                    {r.durationMs != null ? ` · ${Math.round(r.durationMs / 100) / 10}s` : ''}
                    {r.thinking ? ' · thinking' : ''}
                    {r.stopReason ? ` · ${r.stopReason}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {/* The note that used to sit here said per-round tool names and test pass/fail "aren't on
            the wire (the daemon's tool_calls carry no session id)". That stopped being true when
            the fine-tuning capture added the column; the frames were being emitted and dropped at
            ws_server's promotion (Prometheus PR 503). Both now render above. What remains honest to
            say is only what the cap actually hides. */}
        {toolsTruncated ? (
          <div style={{ ...dim, fontSize: 11, marginTop: 8, color: 'var(--c-warn)' }}>
            Showing the most recent {CODING_TOOL_CAP} tool calls — earlier ones in this run are not
            listed. The rounds above are complete; only the per-round tool counts are clipped.
          </div>
        ) : null}
        {acceptance.length > 0 ? (
          <div style={{ ...dim, fontSize: 11, marginTop: 8 }}>
            Acceptance ran {acceptance.length} time{acceptance.length === 1 ? '' : 's'} —{' '}
            {acceptance.map((a, i) => (
              <span key={a.seq ?? i} style={{ color: a.exitCode === 0 ? 'var(--c-ok)' : 'var(--c-err)' }}>
                {i > 0 ? ', ' : ''}
                {a.exitCode === 0 ? 'pass' : `exit ${a.exitCode ?? '?'}`}
                {a.timedOut ? ' (timed out)' : ''}
              </span>
            ))}
            . Ground truth from the command itself, not the model&apos;s claim.
          </div>
        ) : null}
      </div>

      {/* Artifact review (terminal) — reuses the @shared/coding verdict + git commands; review-only. */}
      {terminal ? (
        <ArtifactReview
          report={report}
          managedStatus={status?.status}
          diff={diff}
          diffLoading={diffLoading}
          onLoadDiff={() => void loadDiff()}
        />
      ) : null}
    </div>
  )
}

function ArtifactReview({
  report,
  managedStatus,
  diff,
  diffLoading,
  onLoadDiff
}: {
  report: CodingRunReport | null
  managedStatus?: string
  diff: CodingDiffResult | null
  diffLoading: boolean
  onLoadDiff: () => void
}) {
  const verdict = codingStateLabel(report, managedStatus)
  const cmds = codingGitCommands(report)
  const toneColor = verdict.tone === 'ok' ? 'var(--c-ok)' : verdict.tone === 'err' ? 'var(--c-err)' : 'var(--c-warn)'
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: toneColor }}>{verdict.text}</span>
        {report?.acceptance_exit != null ? <span style={{ ...dim, fontFamily: MONO }}>· acceptance exit {report.acceptance_exit}</span> : null}
        {report?.rounds_used != null ? <span style={dim}>· rounds {report.rounds_used}</span> : null}
        {report?.wall_seconds != null ? <span style={dim}>· {Math.round(report.wall_seconds)}s wall</span> : null}
      </div>
      {report?.reason ? <div style={{ ...dim, marginTop: 6 }}>{report.reason}</div> : null}

      {cmds.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...dim, marginBottom: 6 }}>Review the artifact branch yourself (Beacon never merges or pushes):</div>
          <pre style={{ ...mono, margin: 0, padding: 10, background: 'var(--c-void)', borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre' }}>{cmds.join('\n')}</pre>
          <button style={{ ...btn('line'), marginTop: 8 }} onClick={() => copyText(cmds.join('\n'))}>Copy commands</button>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        {diff == null ? (
          <button style={btn('arc', diffLoading)} disabled={diffLoading} onClick={onLoadDiff}>
            {diffLoading ? 'Loading diff…' : 'Load diff'}
          </button>
        ) : !diff.ready ? (
          <div style={dim}>No diff yet — the run hasn&apos;t reported an artifact.</div>
        ) : !diff.diff ? (
          <div style={dim}>Empty diff — the run made no file changes.</div>
        ) : (
          <pre style={{ ...mono, margin: 0, padding: 10, background: 'var(--c-void)', borderRadius: 6, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre' }}>
            {diff.diff.split('\n').map((line, i) => (
              <div key={i} style={{ color: TONE_COLOR[diffLineTone(line)] }}>{line || ' '}</div>
            ))}
            {diff.truncated ? <div style={{ color: 'var(--c-text-faint)' }}>… (truncated)</div> : null}
          </pre>
        )}
      </div>
    </div>
  )
}
