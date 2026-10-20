import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { isAuthError } from '@shared/daemon-api'
import {
  CODING_DEFAULTS,
  codingGitCommands,
  codingStateLabel,
  diffLineTone,
  elapsedSeconds,
  reportFromStatus,
  roundKey,
  runPhase,
  type CodingDiffResult,
  type CodingLaunchResult,
  type CodingRoundLive,
  type CodingRunLive,
  type CodingRunReport,
  type CodingRunStatus
} from '@shared/coding'
import { NotAuthorized } from './NotAuthorized'
import { useGateway } from '../gateway-store'

// Coding surface (Phase C) — launch a sandboxed iterate-to-green coding run on the daemon
// (POST /api/code), watch it, and review the terminal artifact. REVIEW-ONLY: no merge, no push from
// Beacon — the artifact branch lives in the daemon-side sandbox clone and the owner acts on it via
// the copy-able git commands shown here.
// LIVE: while running, the Live view streams per-ROUND progression from the daemon's authed WS
// (coding_round / coding_complete / coding_stream_error — Prometheus PR #48), in step with the run.
// v1 limitation: per-round TOOL NAME and TEST pass/fail are NOT on the wire (tool_calls has no
// session_id — survey finding); that detail is a tracked daemon follow-up.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const POLL_MS = 2_500

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }
const bodyWrap: CSSProperties = { flex: 1, overflow: 'auto', padding: 16 }
const label: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }
const field: CSSProperties = { fontSize: 13, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', outline: 'none', font: 'inherit', width: '100%', boxSizing: 'border-box' }
const mono: CSSProperties = { ...field, fontFamily: MONO }
const btn = (primary = false, disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '8px 16px',
  borderRadius: 6,
  border: `1px solid ${primary ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : primary ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : primary ? 'var(--c-on-arc)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})
const card: CSSProperties = { border: '1px solid var(--c-line)', borderRadius: 8, padding: 14, marginBottom: 12, background: 'var(--c-raise)' }
const pre: CSSProperties = { margin: 0, fontFamily: MONO, fontSize: 12, color: 'var(--c-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const dim: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)' }
const toneColor = (t: 'ok' | 'warn' | 'err'): string => (t === 'ok' ? 'var(--c-ok)' : t === 'err' ? 'var(--c-err)' : 'var(--c-warn)')

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).catch(() => undefined)
}

interface ActiveRun {
  managedId: string
  codingId: string
}

export function CodingPanel() {
  // Launch form
  const [repo, setRepo] = useState('')
  const [task, setTask] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [maxRounds, setMaxRounds] = useState(String(CODING_DEFAULTS.maxRounds))
  const [maxWall, setMaxWall] = useState(String(CODING_DEFAULTS.maxWallSeconds))
  const [launching, setLaunching] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [authErr, setAuthErr] = useState(false)

  // Active run
  const [run, setRun] = useState<ActiveRun | null>(null)
  const [status, setStatus] = useState<CodingRunStatus | null>(null)
  const [report, setReport] = useState<CodingRunReport | null>(null)
  const [, forceTick] = useState(0) // re-render the elapsed clock while running
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const launch = useCallback(async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setLaunching(true)
    setFormErr(null)
    setAuthErr(false)
    try {
      const body = {
        repo: repo.trim(),
        description: task.trim(),
        acceptance_command: acceptance.trim(),
        max_rounds: Number(maxRounds) || CODING_DEFAULTS.maxRounds,
        max_wall_seconds: Number(maxWall) || CODING_DEFAULTS.maxWallSeconds
      }
      const res = (await b.daemon.write('/api/code', body)) as CodingLaunchResult
      setRun({ managedId: res.task_id, codingId: res.coding_task_id })
      setStatus(null)
      setReport(null)
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
      else setFormErr(String(e instanceof Error ? e.message : e))
    } finally {
      setLaunching(false)
    }
  }, [repo, task, acceptance, maxRounds, maxWall])

  // Poll the managed task while a run is active and not yet in review.
  useEffect(() => {
    if (!run) return
    let alive = true
    const tick = async (): Promise<void> => {
      const b = window.beacon
      if (!b) return
      try {
        const s = (await b.daemon.get(`/api/code/${encodeURIComponent(run.managedId)}`)) as CodingRunStatus
        if (!alive) return
        setStatus(s)
        const rep = reportFromStatus(s)
        if (rep) setReport(rep)
        if (runPhase(s.status, !!rep) === 'review' && timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      } catch (e) {
        if (!alive) return
        if (isAuthError(e)) {
          setAuthErr(true)
          if (timerRef.current) clearInterval(timerRef.current)
        }
      }
    }
    void tick()
    timerRef.current = setInterval(tick, POLL_MS)
    const clock = setInterval(() => forceTick((n) => n + 1), 1_000)
    return () => {
      alive = false
      if (timerRef.current) clearInterval(timerRef.current)
      clearInterval(clock)
    }
  }, [run])

  const [stopping, setStopping] = useState(false)
  const stop = useCallback(async (): Promise<void> => {
    const b = window.beacon
    if (!b || !run) return
    setStopping(true)
    try {
      // POST /api/code/{id}/stop — the daemon SIGTERM→SIGKILLs the run; the poll picks up the
      // 'killed' status and flips this panel to review.
      await b.daemon.write(`/api/code/${encodeURIComponent(run.managedId)}/stop`)
    } catch (e) {
      if (isAuthError(e)) setAuthErr(true)
    } finally {
      setStopping(false)
    }
  }, [run])

  const reset = (): void => {
    setRun(null)
    setStatus(null)
    setReport(null)
    setFormErr(null)
    setStopping(false)
  }

  if (authErr) {
    return (
      <div style={panel}>
        <div style={head}><Title /></div>
        <div style={bodyWrap}><NotAuthorized what="coding runs" /></div>
      </div>
    )
  }

  const { codingRuns } = useGateway()
  const live = run ? (codingRuns[`coding:${run.codingId}`] ?? null) : null
  const phase = run ? runPhase(status?.status, !!report) : 'launch'

  return (
    <div style={panel}>
      <div style={head}>
        <Title />
        <div style={{ flex: 1 }} />
        {run ? (
          <button style={btn(false)} onClick={reset} title="Start a new coding run">
            ＋ New run
          </button>
        ) : null}
      </div>
      <div style={bodyWrap}>
        {phase === 'launch' ? (
          <LaunchForm
            {...{ repo, setRepo, task, setTask, acceptance, setAcceptance, maxRounds, setMaxRounds, maxWall, setMaxWall, launching, formErr }}
            onLaunch={() => void launch()}
          />
        ) : phase === 'running' ? (
          <LiveRun run={run!} status={status} live={live} onStop={() => void stop()} stopping={stopping} />
        ) : (
          <ArtifactReview run={run!} status={status} report={report} />
        )}
      </div>
    </div>
  )
}

/** The pill row above already says "Run" (R2); this row carries only the caption and the actions. */
function Title() {
  return <span style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>One coding task, in one repository</span>
}

function LaunchForm(props: {
  repo: string; setRepo: (s: string) => void
  task: string; setTask: (s: string) => void
  acceptance: string; setAcceptance: (s: string) => void
  maxRounds: string; setMaxRounds: (s: string) => void
  maxWall: string; setMaxWall: (s: string) => void
  launching: boolean; formErr: string | null
  onLaunch: () => void
}) {
  const ready = props.repo.trim() && props.task.trim() && props.acceptance.trim() && !props.launching
  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ ...dim, marginTop: 0, lineHeight: 1.5 }}>
        Prometheus copies the repository, works on the task in a sandbox until your check passes, and leaves the result on a
        branch for you to review. It never merges or pushes. The folder is on the computer running Prometheus.
      </p>
      <label style={label}>
        Repository folder (on the computer running Prometheus, a git repository)
        <input style={mono} value={props.repo} onChange={(e) => props.setRepo(e.target.value)} placeholder="/path/to/your-project" spellCheck={false} />
      </label>
      <label style={label}>
        Task
        <textarea style={{ ...field, minHeight: 70, resize: 'vertical' }} value={props.task} onChange={(e) => props.setTask(e.target.value)} placeholder="What should the agent do?" />
      </label>
      <label style={label}>
        Acceptance command (must exit 0 for the task to count as converted)
        <input style={mono} value={props.acceptance} onChange={(e) => props.setAcceptance(e.target.value)} placeholder="PYTHONPATH=src python3 -m pytest tests/ -q" spellCheck={false} />
      </label>
      <div style={{ display: 'flex', gap: 12 }}>
        <label style={{ ...label, flex: 1 }}>
          Max rounds
          <input style={field} type="number" value={props.maxRounds} onChange={(e) => props.setMaxRounds(e.target.value)} />
        </label>
        <label style={{ ...label, flex: 1 }}>
          Max wall seconds
          <input style={field} type="number" value={props.maxWall} onChange={(e) => props.setMaxWall(e.target.value)} />
        </label>
      </div>
      {props.formErr ? <div style={{ fontSize: 12, color: 'var(--c-err)', marginBottom: 10 }}>{props.formErr}</div> : null}
      <button style={btn(true, !ready)} disabled={!ready} onClick={props.onLaunch}>
        {props.launching ? 'Launching…' : 'Launch run'}
      </button>
    </div>
  )
}

function LiveRun({ run, status, live, onStop, stopping }: { run: ActiveRun; status: CodingRunStatus | null; live: CodingRunLive | null; onStop: () => void; stopping: boolean }) {
  const elapsed = elapsedSeconds(status?.started_at, status?.ended_at, Date.now())
  const rounds = live?.rounds ?? []
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Auto-scroll the round list to the latest as rounds stream in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rounds.length])
  return (
    <div style={{ maxWidth: 720 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>
            {live?.complete ? 'Finishing…' : status?.status === 'running' || !status ? 'Running' : status.status}
          </span>
          <span style={{ ...dim, fontFamily: MONO }}>· {elapsed}s</span>
          {rounds.length ? <span style={{ ...dim, fontFamily: MONO }}>· round {rounds[rounds.length - 1].roundIndex}</span> : null}
        </div>
        <div style={{ ...dim, marginTop: 8 }}>
          Branch <code style={{ fontFamily: MONO, color: 'var(--c-arc)' }}>coding/{run.codingId}</code> · managed task{' '}
          <code style={{ fontFamily: MONO }}>{run.managedId}</code>
        </div>
      </div>

      {live?.streamError ? (
        <div style={{ ...card, borderColor: 'var(--c-warn)' }}>
          <span style={{ color: 'var(--c-warn)', fontSize: 13 }}>⚠ Live updates interrupted</span>
          <div style={{ ...dim, marginTop: 4 }}>
            The round stream hit an error ({live.streamError}). The run itself continues on the computer running Prometheus,
            and the final report will still load here when it ends.
          </div>
        </div>
      ) : null}

      <SectionTitle>Rounds</SectionTitle>
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {rounds.length === 0 ? (
          <div style={{ ...dim, padding: 14 }}>Waiting for the first round… (the model is starting up)</div>
        ) : (
          <div ref={scrollRef} style={{ maxHeight: 420, overflow: 'auto' }}>
            {rounds.map((r, i) => (
              <RoundRow key={roundKey(r)} r={r} divider={i > 0} />
            ))}
          </div>
        )}
      </div>

      <button style={{ ...btn(false, stopping), marginTop: 12 }} disabled={stopping} onClick={onStop} title="Stop this coding run">
        {stopping ? 'Stopping…' : 'Stop run'}
      </button>
    </div>
  )
}

function RoundRow({ r, divider }: { r: CodingRoundLive; divider: boolean }) {
  const ok = r.outcome === 'success'
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
        borderTop: divider ? '1px solid var(--c-line)' : 'none',
        fontFamily: MONO, fontSize: 12
      }}
    >
      <span style={{ color: 'var(--c-text-dim)', minWidth: 64 }}>round {r.roundIndex}</span>
      <span style={{ color: ok ? 'var(--c-ok)' : 'var(--c-err)', minWidth: 60 }}>{r.outcome}</span>
      <span style={{ color: 'var(--c-text-dim)' }}>{r.inputTokens ?? '–'}→{r.outputTokens ?? '–'} tok</span>
      {r.durationMs != null ? <span style={{ color: 'var(--c-text-faint)' }}>{Math.round(r.durationMs)}ms</span> : null}
      {r.thinking ? <span style={{ color: 'var(--c-arc)' }} title="thinking on">◇</span> : null}
      <div style={{ flex: 1 }} />
      {r.stopReason ? <span style={{ color: 'var(--c-text-faint)' }}>{r.stopReason}</span> : null}
    </div>
  )
}

function ArtifactReview({ run, status, report }: { run: ActiveRun; status: CodingRunStatus | null; report: CodingRunReport | null }) {
  const verdict = codingStateLabel(report, status?.status)
  const cmds = codingGitCommands(report)
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: toneColor(verdict.tone) }}>{verdict.text}</span>
          {report?.acceptance_exit != null ? (
            <span style={{ ...dim, fontFamily: MONO }}>· acceptance exit {report.acceptance_exit}</span>
          ) : null}
        </div>
        {report?.reason ? <div style={{ ...dim, marginTop: 6 }}>{report.reason}</div> : null}
        <div style={{ ...dim, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: MONO }}>
          {report?.rounds_used != null ? <span>rounds {report.rounds_used}</span> : null}
          {report?.episodes != null ? <span>episodes {report.episodes}</span> : null}
          {report?.wall_seconds != null ? <span>{Math.round(report.wall_seconds)}s</span> : null}
        </div>
      </div>

      <SectionTitle>Branch</SectionTitle>
      <div style={card}>
        <code style={{ fontFamily: MONO, color: 'var(--c-arc)', fontSize: 13 }}>{report?.branch ?? `coding/${run.codingId}`}</code>
        {report?.diff_stat ? <pre style={{ ...pre, marginTop: 10 }}>{report.diff_stat}</pre> : null}
      </div>

      <SectionTitle>Diff</SectionTitle>
      <DiffView managedId={run.managedId} />

      <SectionTitle>Final test output</SectionTitle>
      <div style={card}>
        {report?.acceptance_output_tail ? (
          <pre style={pre}>{report.acceptance_output_tail}</pre>
        ) : (
          <div style={dim}>{status?.error ? status.error : 'No acceptance output captured.'}</div>
        )}
      </div>

      {cmds.length ? (
        <>
          <SectionTitle>Review it yourself (review-only — Beacon never merges or pushes)</SectionTitle>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={dim}>Run these on the computer running Prometheus:</span>
              <button style={btn(false)} onClick={() => copyText(cmds.join('\n'))}>⧉ Copy all</button>
            </div>
            <pre style={pre}>{cmds.join('\n')}</pre>
          </div>
        </>
      ) : null}
    </div>
  )
}

const diffToneColor: Record<string, string> = {
  add: 'var(--c-ok)',
  del: 'var(--c-err)',
  hunk: 'var(--c-arc)',
  meta: 'var(--c-text-dim)',
  context: 'var(--c-text)'
}

function DiffView({ managedId }: { managedId: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [diff, setDiff] = useState('')
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    setState('loading')
    void b.daemon
      .get(`/api/code/${encodeURIComponent(managedId)}/diff`)
      .then((r) => {
        if (!alive) return
        const res = r as CodingDiffResult
        if (!res.ready || !res.diff) {
          setState('empty')
          return
        }
        setDiff(res.diff)
        setTruncated(!!res.truncated)
        setState('ready')
      })
      .catch(() => {
        if (alive) setState('error')
      })
    return () => {
      alive = false
    }
  }, [managedId])

  if (state === 'loading') return <div style={{ ...card, ...dim }}>Loading diff…</div>
  if (state === 'error') return <div style={{ ...card, ...dim }}>Couldn&apos;t load the diff. Use the git commands below.</div>
  if (state === 'empty') return <div style={{ ...card, ...dim }}>No diff (the run produced no committed artifact — e.g. stopped or errored early).</div>
  const lines = diff.split('\n')
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 10px', borderBottom: '1px solid var(--c-line)' }}>
        <button style={btn(false)} onClick={() => copyText(diff)}>⧉ Copy diff</button>
      </div>
      <pre style={{ ...pre, padding: 12, overflow: 'auto', maxHeight: 520, lineHeight: 1.5 }}>
        {lines.map((ln, i) => (
          <div key={i} style={{ color: diffToneColor[diffLineTone(ln)] }}>{ln || ' '}</div>
        ))}
      </pre>
      {truncated ? <div style={{ ...dim, padding: '0 12px 10px' }}>… diff truncated at 256 KB — use the git commands below for the full change.</div> : null}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--c-text-dim)', margin: '4px 0 8px' }}>{children}</div>
}

function Spinner() {
  // A steady arc-tinted dot, not an animated spinner — there's no global spin keyframe and the
  // design system keeps the message/run area motion-free (reduced-motion friendly). The elapsed
  // clock ticking beside it already signals liveness.
  return (
    <span
      style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--c-arc)', boxShadow: '0 0 6px var(--c-arc)', display: 'inline-block', flexShrink: 0 }}
      aria-hidden
    />
  )
}
