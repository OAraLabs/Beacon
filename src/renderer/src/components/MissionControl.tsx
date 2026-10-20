import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import { fmtUptime, isAuthError, asList, httpStatusFromError, type AgentStatusDTO, type SentinelDTO, type TelemetryDTO, type StoryDTO, rateColor, toolCallsReading } from '@shared/daemon-api'
import { docsListPath, docsReadPath, type DocListDTO, type DocReadDTO } from '@shared/documents'
import {
  DOCS_LIST_CAP,
  PLAN_BANNERS,
  PLAN_DIR,
  PLAN_SUMMARY_READ_CAP,
  listHitCap,
  planStateFrom,
  rollUpPlans,
  sumRatios
} from '@shared/plan'
import {
  EMPTY_TASKS,
  REFUSED_TASKS_PATH,
  backgroundSummary,
  backgroundSummaryTitle,
  cronTrouble,
  recentRefusals,
  refusedBadge,
  fmtCountdown,
  fmtDuration,
  nextRuns,
  parseCron,
  parseTasks,
  type CronJob,
  type TaskSnapshot
} from '@shared/background'
import { composeAttention } from '@shared/attention'
import type { ModelCatalog, ModelOption } from '@shared/composer-controls'
import type { ViewId } from '@shared/views'
import { backendReading, cloudTwin, defaultRowLabel, isCloudPrimary } from '@shared/backend-health'
import { useGateway } from '../gateway-store'
import { useBackendRecheck } from '../backend-recheck'
import { clearStall, useStalls } from '../attention-store'
import { Icon } from './Icon'
import { NotAuthorized } from './NotAuthorized'
import { OwnerOnlyNote, useConnectionRefused, useDeviceRole } from './OwnerOnlyNote'

// Mission Control (Makeover Slice 7, Track C #1) — the cockpit home for a 24/7 sovereign agent:
// live agent state, link + model, pending approvals (actionable), task ticker, telemetry headline,
// sentinel, recent activity — every datum from endpoints that already exist. Chat stays the
// default view; this is the "what has my agent been doing" answer, one keystroke away (⌘K → mission).

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const REFRESH_MS = 30_000

/** Unwrap the daemon's {"error": "..."} envelope so a banner reads as prose, not as a stack. */
function cleanErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const match = m.match(/\{"error":"([^"]+)"\}/)
  return match ? match[1] : m
}

// The HUD flows in Mission's right column (MissionHome), which does the scrolling. Every card
// sizes to its content and an EMPTY card is one row (R5): label · sentence · count. One accent per
// region (R6): sang is the agent strip's "New chat" and nothing else; status keeps its own scale —
// online for healthy, lapis for a pending permission / a secondary link, idle for queued, sang
// for error. Mono for every number, label, path and duration; the serif for sentences (R7).
// Nothing informational below --ink4 (R8): caps labels are --ink3, timestamps/counts --ink4.
// A status colour used as a WORD takes its -text variant (scripts/check-contrast.mjs); as a dot
// or a fill it keeps the raw token.
const panel: CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }
const card: CSSProperties = {
  background: 'var(--node)',
  border: '1px solid var(--line2)',
  borderRadius: 10,
  padding: '9px 13px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0
}
const cardTitle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: MONO,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 'var(--track-caps)',
  color: 'var(--ink3)'
}
const sentence: CSSProperties = { fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--ink2)' }
const mono11: CSSProperties = { fontFamily: MONO, fontSize: 11, color: 'var(--ink4)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }
const bigStat: CSSProperties = { fontFamily: MONO, fontSize: 22, fontVariantNumeric: 'tabular-nums', color: 'var(--ink)', lineHeight: 1.1 }
const statLabel: CSSProperties = { fontFamily: MONO, fontSize: 10, textTransform: 'uppercase', letterSpacing: 'var(--track-caps)', color: 'var(--ink3)' }
const actionBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  padding: '5px 11px',
  borderRadius: 'var(--r-2)',
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--ink)',
  cursor: 'pointer',
  font: 'inherit'
}
/** The region's ONE primary action. */
const primaryBtn: CSSProperties = { ...actionBtn, background: 'var(--sang)', borderColor: 'var(--sang)', color: 'var(--on-sang)' }
/** A secondary link: lapis, never sang (R6). */
const linkBtn: CSSProperties = { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 12, color: 'var(--lapis-text)', cursor: 'pointer', flexShrink: 0 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const ellipsis: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const dot = (color: string): CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none' })

function Card({ title, icon, children, accent, right }: { title: string; icon: ReactNode; children: ReactNode; accent?: string; right?: ReactNode }) {
  return (
    <section style={{ ...card, ...(accent ? { borderColor: accent } : {}) }}>
      <div style={{ ...cardTitle, justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {icon}
          {title}
        </span>
        {right}
      </div>
      {children}
    </section>
  )
}

/** R5: a card whose body would be one empty-state sentence IS one row — label · sentence · count. */
function EmptyRow({ title, icon, children, count }: { title: string; icon: ReactNode; children: ReactNode; count?: ReactNode }) {
  return (
    <section style={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 10, padding: '7px 13px' }}>
      <span style={cardTitle}>
        {icon}
        {title}
      </span>
      <span style={{ ...sentence, ...ellipsis }}>{children}</span>
      {count !== undefined ? <span style={mono11}>{count}</span> : null}
    </section>
  )
}

function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export function MissionControl({
  approvals,
  onResolveApproval,
  onNewChat,
  onOpenView
}: {
  approvals: ApprovalRequest[]
  onResolveApproval: (id: string, decision: ApprovalDecision) => void
  onNewChat: () => void
  onOpenView: (v: ViewId) => void
}) {
  const { agentState, activity, toolCalls } = useGateway()
  // An approved device (not the owner) may see its own approvals and activity, and nothing else here: the rest is the note, and none
  // of it is asked for (the 0.4.5 sweep, S1: raw 403s, "Catalog unavailable.", "— · — · —", "up 0s").
  const role = useDeviceRole()
  const limited = role === 'limited'
  // A connection Beacon will not use (plain to the internet): nothing is asked, and every card is calm (the banner says why).
  const connRefused = useConnectionRefused() !== null
  const [status, setStatus] = useState<AgentStatusDTO | null>(null)
  const [sentinel, setSentinel] = useState<SentinelDTO | null>(null)
  const [telemetry, setTelemetry] = useState<TelemetryDTO | null>(null)
  const [outboxFailed, setOutboxFailed] = useState(0)
  const [taskSnap, setTaskSnap] = useState<TaskSnapshot>(EMPTY_TASKS)
  // Refusals only, newest first (issue 278), for the card's recent count. Fetched only when the
  // all-time histogram has any: no refusals ever means no second request.
  const [refusedSnap, setRefusedSnap] = useState<TaskSnapshot>(EMPTY_TASKS)
  const [cron, setCron] = useState<CronJob[]>([])
  const [stopping, setStopping] = useState<string | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsDefaultKey, setModelsDefaultKey] = useState('local')
  const [authErr, setAuthErr] = useState(false)
  // ── The plan rollup (read-only). Mission is the landing surface, so this is the first thing
  // that can lie: an unreadable board and an empty board must not share a rendering.
  const [stories, setStories] = useState<StoryDTO[]>([])
  const [storiesErr, setStoriesErr] = useState<string | null>(null)
  const [planFiles, setPlanFiles] = useState<string[]>([])
  const [planFilesErr, setPlanFilesErr] = useState<string | null>(null)
  const [planDirMissing, setPlanDirMissing] = useState(false)
  const [planListCapped, setPlanListCapped] = useState(false)
  const [ratios, setRatios] = useState<Record<string, { done: number; total: number }>>({})
  const [ratiosRead, setRatiosRead] = useState(0)
  const stalls = useStalls()

  const rollup = rollUpPlans(stories, planFiles)

  // Ratios cost one read per story WITH a plan, on the default landing view, so they are capped.
  // The counts above are NOT capped — only the done/total detail is — and the card says so when
  // the cap bites rather than letting eight-of-twelve read as the whole board.
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    const targets = rollup.rows
      .filter((r) => r.resolution.kind === 'one')
      .slice(0, PLAN_SUMMARY_READ_CAP)
    if (targets.length === 0) {
      setRatios({})
      setRatiosRead(0)
      return
    }
    let live = true
    void Promise.all(
      targets.map((r) =>
        b.daemon
          .get(docsReadPath(`${PLAN_DIR}/${(r.resolution as { path: string }).path}`))
          .then((d) => {
            const doc = d as DocReadDTO | null
            const st = planStateFrom(r.resolution, doc?.content ?? '', doc?.truncated === true)
            return st.kind === 'checklist'
              ? ([r.storyId, { done: st.done, total: st.total }] as const)
              : ([r.storyId, { done: 0, total: 0 }] as const)
          })
          // A read that fails contributes NOTHING rather than a zero — a zero would read as
          // "a plan with no steps", which is a different fact from "we could not read it".
          .catch(() => null)
      )
    ).then((pairs) => {
      if (!live) return
      const next: Record<string, { done: number; total: number }> = {}
      for (const pr of pairs) if (pr) next[pr[0]] = pr[1]
      setRatios(next)
      setRatiosRead(targets.length)
    })
    return () => {
      live = false
    }
    // planFiles/stories identity changes on each poll; the rollup is derived from both.
  }, [stories, planFiles])

  const load = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    void b.outbox.status().then((o) => setOutboxFailed(o.failed)).catch(() => undefined)
    // Known to be an approved device means its key was just accepted (GET /api/devices answered it), so a 401 from before (a read
    // made before the key was in place) is stale; only /api/status, which this device never reads, would otherwise clear it.
    if (limited || connRefused) {
      setAuthErr(false)
      return
    }
    // Main has not said yet whether this is the owner (the page's first moments): ask nothing it might refuse; the role's arrival reloads.
    if (role === undefined) return
    void b.daemon
      .get('/api/status')
      .then((d) => {
        setAuthErr(false)
        setStatus((d as AgentStatusDTO) ?? null)
      })
      .catch((e) => {
        if (isAuthError(e)) setAuthErr(true)
      })
    void b.daemon.get('/api/sentinel').then((d) => setSentinel((d as SentinelDTO) ?? null)).catch(() => undefined)
    void b.daemon.get('/api/telemetry').then((d) => setTelemetry((d as TelemetryDTO) ?? null)).catch(() => undefined)
    // Background work: the durable task list (before the list_tasks fix this answered "nothing"
    // after every restart) and the cron schedule, which is where the recurring work on this box
    // actually lives.
    void b.daemon
      .get('/api/tasks')
      .then((d) => {
        const snap = parseTasks(d)
        setTaskSnap(snap)
        if ((snap.counts.blocked ?? 0) > 0) return b.daemon.get(REFUSED_TASKS_PATH).then((r) => setRefusedSnap(parseTasks(r)))
        setRefusedSnap(EMPTY_TASKS)
      })
      .catch(() => undefined)
    void b.daemon.get('/api/cron').then((d) => setCron(parseCron(d))).catch(() => undefined)
    // Board + plan files. FAIL-LOUD on both: `.catch(() => undefined)` here would render an
    // unreachable daemon as "no stories yet", which is the exact collapse the plan panel exists
    // to refuse — and on the landing view it would be the first thing anyone sees.
    void b.daemon
      .get('/api/stories')
      .then((d) => {
        setStoriesErr(null)
        setStories(asList<StoryDTO>(d))
      })
      .catch((e) => {
        if (isAuthError(e)) setAuthErr(true)
        else setStoriesErr(cleanErr(e))
      })
    void b.daemon
      .get(docsListPath(PLAN_DIR))
      .then((d) => {
        setPlanFilesErr(null)
        setPlanDirMissing(false)
        const entries = (d as DocListDTO | null)?.entries ?? []
        setPlanListCapped(listHitCap(entries.length))
        setPlanFiles(entries.filter((e) => e.type === 'file').map((e) => e.name))
      })
      .catch((e) => {
        if (httpStatusFromError(e) === 404) {
          setPlanDirMissing(true)
          setPlanFilesErr(null)
          setPlanFiles([])
          setPlanListCapped(false)
        } else setPlanFilesErr(cleanErr(e))
      })
    void b.daemon
      .get('/api/models')
      .then((d) => {
        const cat = d as ModelCatalog | null
        if (cat && Array.isArray(cat.models)) {
          setModels(cat.models)
          if (cat.default_key) setModelsDefaultKey(cat.default_key)
        }
      })
      .catch(() => setModels([]))
  }, [limited, connRefused, role])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  // A stale or never-taken reading on a local server's row is checked again (the owner's probe route; at most every 30 s per server).
  // Above the early return: a hook after it is a different hook count once authErr flips (React 300, the probe's first run).
  useBackendRecheck(
    models.filter((m) => m.backend).map((m) => ({ name: m.backend as string, health: m.health })),
    role === 'owner' && !connRefused,
    load
  )

  if (authErr) {
    return (
      <div style={panel}>
        <NotAuthorized what="mission control" />
      </div>
    )
  }

  const thinking = agentState === 'thinking'
  const liveCalls = toolCalls.filter((t) => t.success === undefined).length
  const taskEvents = activity.filter((a) => a.type.startsWith('task_')).slice(-6).reverse()
  const recent = activity.slice(-8).reverse()
  const callsReading = toolCallsReading(telemetry?.total_calls, telemetry?.overall_success_rate)
  const successPct = callsReading.kind === 'calls' ? callsReading.pct : null
  const attention = composeAttention(approvals, stalls, outboxFailed)
  // A local server's row: UP or DOWN from its last check (health.ok: the daemon hard-codes available on the Local row), never "stale".
  const readingOf = (m: ModelOption) => backendReading(m.available, m.health)
  const modelsReady = models.filter((m) => (m.backend ? readingOf(m).state !== 'down' : m.available !== false)).length
  const defaultModel = models.find((m) => m.is_default || m.key === modelsDefaultKey) ?? null
  const runningTasks = taskSnap.tasks.filter((t) => t.running)
  const upcoming = nextRuns(cron, 3)
  const troubled = cronTrouble(cron)

  // Stop, then re-read the list rather than assuming the outcome: the daemon returns the record
  // AFTER the stop, and a card that removed the row optimistically would be claiming a result it
  // did not observe.
  async function stopTask(id: string): Promise<void> {
    setStopping(id)
    try {
      await window.beacon?.daemon.write(`/api/tasks/${encodeURIComponent(id)}/stop`, undefined, 'POST')
      const fresh = await window.beacon?.daemon.get('/api/tasks')
      setTaskSnap(parseTasks(fresh))
    } catch {
      // leave the row visible; the next poll reconciles
    } finally {
      setStopping(null)
    }
  }

  const failedTasks = taskSnap.counts.failed ?? 0
  // A SecurityGate refusal is its own terminal status since Prometheus issue 489, so `failed` above
  // now counts only work that actually ran and broke. Refusals get their own affordance rather
  // than none: they are ACTIONABLE (approve the command, or narrow it) and they are not trouble,
  // so this reads as a queue and never takes the card's alarm accent.
  const refusedTasks = taskSnap.counts.blocked ?? 0
  // Issue 278: the card's number is RECENT (this week), the all-time total is in the tooltip.
  const refused = refusedBadge(recentRefusals(refusedSnap), refusedTasks)

  return (
    <div style={panel}>
      {/* ── 1. Agent strip: the agent, right now — and the page's one primary action ── */}
      <section style={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 16, borderColor: thinking ? 'var(--online)' : 'var(--line2)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 96 }}>
          <span style={statLabel}>agent</span>
          <span style={{ ...bigStat, color: thinking ? 'var(--online-text)' : 'var(--ink)' }}>
            {(agentState ?? status?.state ?? 'idle').toUpperCase()}
          </span>
          {liveCalls > 0 ? (
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--online-text)' }}>{liveCalls} tool call{liveCalls === 1 ? '' : 's'} live</span>
          ) : null}
        </div>
        {limited || connRefused ? (
          <div style={{ flex: 1 }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <span style={statLabel}>model · provider · profile</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--ink5)', ...ellipsis }} title={`${status?.model ?? '?'} · ${status?.provider ?? '?'} · ${status?.profile ?? '?'}`}>
              {status?.model ?? '—'} <span style={{ color: 'var(--ink4)' }}>· {status?.provider ?? '—'} · {status?.profile ?? '—'}</span>
            </span>
            <span style={mono11}>up {fmtUptime(status?.uptime_seconds)}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
          <button style={primaryBtn} onClick={onNewChat}>
            <Icon name="plus" size={13} /> New chat
          </button>
          <button style={actionBtn} onClick={() => void window.beacon?.connection.reconnect()}>
            <Icon name="refresh" size={13} /> Reconnect
          </button>
          <button style={{ ...actionBtn, padding: '5px 7px' }} onClick={() => window.dispatchEvent(new Event('beacon:open-settings'))} title="Connection settings" aria-label="Connection settings">
            <Icon name="config" size={13} />
          </button>
        </div>
      </section>

      {/* ── 2. Needs you — ONE queue for everything blocked on the operator: approvals (consent), stalled
           sessions (reply watchdog), failed sends (outbox). Empty → one row (R5). A pending
           permission is a request, not an error: lapis (R6). ── */}
      {attention.length === 0 ? (
        <EmptyRow title="needs you" icon={<Icon name="lock" size={12} />} count={0}>
          Nothing waiting on you.
        </EmptyRow>
      ) : (
        <Card title={`needs you · ${attention.length}`} icon={<Icon name="lock" size={12} />} accent="var(--lapis)">
          {attention.slice(0, 6).map((item) => {
            if (item.kind === 'approval') {
              const a = item.approval
              return (
                <div key={item.key} style={row}>
                  <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: 'var(--lapis-text)' }} title={a.description}>
                    {a.toolName}
                  </span>
                  {/* SPRINT-CONSENT: this triage row offers ONLY the grant-free action, and says
                      so on the button. Anything that outlives the call has an extent that must be
                      read before it is consented to, and that lives on ExecApprovalCard where the
                      daemon's description of each scope is shown in full. A compact inbox is the
                      wrong place to widen a permission — an unlabelled "Approve" here is how the
                      original defect looked. */}
                  <button style={{ ...actionBtn, padding: '3px 9px', color: 'var(--online-text)' }} onClick={() => onResolveApproval(a.requestId, { kind: 'approve', scope: 'once' })}>
                    Approve once
                  </button>
                  <button style={{ ...actionBtn, padding: '3px 9px', color: 'var(--sang-text)' }} onClick={() => onResolveApproval(a.requestId, { kind: 'deny' })}>
                    Deny
                  </button>
                </div>
              )
            }
            if (item.kind === 'stall') {
              return (
                <div key={item.key} style={row}>
                  <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: 'var(--idle-text)' }} title={item.sessionId}>
                    {item.sessionId.slice(0, 14)}… quiet {relTime(item.since)}
                  </span>
                  <button
                    style={{ ...actionBtn, padding: '3px 9px' }}
                    onClick={() => {
                      onOpenView('chat')
                      window.dispatchEvent(new CustomEvent('beacon:open-session', { detail: item.sessionId }))
                    }}
                  >
                    Open
                  </button>
                  <button style={{ ...actionBtn, padding: '3px 7px', color: 'var(--ink4)' }} onClick={() => clearStall(item.sessionId)} title="Dismiss" aria-label="Dismiss">
                    <Icon name="x" size={12} />
                  </button>
                </div>
              )
            }
            return (
              <div key={item.key} style={row}>
                <span style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: 'var(--sang-text)' }}>
                  {item.failed} failed send{item.failed === 1 ? '' : 's'} in the outbox
                </span>
                <button style={{ ...actionBtn, padding: '3px 9px' }} onClick={() => void window.beacon?.connection.reconnect()}>
                  <Icon name="refresh" size={12} /> Retry
                </button>
              </div>
            )
          })}
        </Card>
      )}

      {limited ? (
        <OwnerOnlyNote area="mission" compact />
      ) : connRefused ? (
        <EmptyRow title="connection" icon={<Icon name="lock" size={12} />}>
          Not connected.
        </EmptyRow>
      ) : (
        <>
          {/* ── 3. Background. Tasks AND cron, because on this box cron IS the background work — 4
               jobs daily against 24 ad-hoc tasks in two and a half months. A card built on tasks
               alone would be empty almost always: correct, and useless. The header row carries the
               summary (never a bare blank: "nothing running" ≠ "nothing has ever run") and, when
               there are failures, a lapis link to them (R6: a secondary signal, not an alarm).
               Refusals get a SECOND link and never the accent: since Prometheus issue 489 a gate refusal
               is its own status, and a permission boundary doing its job is a queue, not damage. ── */}
          <Card
            title={`background · ${runningTasks.length} running`}
            icon={<Icon name="clock" size={13} />}
            accent={troubled.length > 0 ? 'var(--sang)' : undefined}
            right={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ ...sentence, fontSize: 12, textTransform: 'none', letterSpacing: 0, ...ellipsis }} title={backgroundSummaryTitle(taskSnap)}>
                  {backgroundSummary(taskSnap)}
                </span>
                {failedTasks > 0 ? (
                  <button style={linkBtn} onClick={() => onOpenView('activity')} title="Open the Activity feed">
                    {failedTasks} failed →
                  </button>
                ) : null}
                {refused.show ? (
                  <button style={linkBtn} onClick={() => onOpenView('activity')} title={refused.title} data-testid="refused-recent">
                    {refused.text}
                  </button>
                ) : null}
              </span>
            }
          >
            {runningTasks.map((t) => (
              <div key={t.id} style={{ ...row, padding: '2px 0' }}>
                <span style={{ color: 'var(--online)', flexShrink: 0 }} aria-hidden>
                  <Icon name="zap" size={12} />
                </span>
                <span style={{ ...ellipsis, fontSize: 12, color: 'var(--ink5)' }}>{t.description || t.type}</span>
                <span style={mono11}>{fmtDuration(t.durationS)}</span>
                <button
                  onClick={() => void stopTask(t.id)}
                  disabled={stopping === t.id}
                  title={`Stop ${t.description || t.type}`}
                  aria-label={`Stop task ${t.id}`}
                  style={{ fontFamily: MONO, fontSize: 10, padding: '1px 7px', borderRadius: 5, border: '1px solid var(--line)', background: 'transparent', color: stopping === t.id ? 'var(--ink4)' : 'var(--ink2)', cursor: stopping === t.id ? 'not-allowed' : 'pointer', flexShrink: 0 }}
                >
                  {stopping === t.id ? '…' : 'stop'}
                </button>
              </div>
            ))}
            {upcoming.length > 0 ? (
              <>
                <div style={{ ...statLabel, fontSize: 9, marginTop: runningTasks.length > 0 ? 6 : 0 }}>scheduled</div>
                {upcoming.map((j) => {
                  const failed = !!j.lastStatus && j.lastStatus !== 'success'
                  const when = fmtCountdown(j.nextRun)
                  return (
                    <div key={j.name} style={{ ...row, padding: '1px 0' }}>
                      {/* A glyph, not a word — the raw fill colours are correct here. */}
                      <span
                        style={{ color: failed ? 'var(--sang)' : 'var(--online)', flexShrink: 0, display: 'inline-flex' }}
                        aria-label={j.lastStatus === 'success' ? 'last run ok' : `last run ${j.lastStatus ?? 'unknown'}`}
                      >
                        <Icon name={failed ? 'x' : 'check'} size={11} />
                      </span>
                      <span title={j.schedule} style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: 'var(--ink5)' }}>
                        {j.name}
                      </span>
                      <span style={{ ...mono11, color: when === 'due now' || when === 'overdue' ? 'var(--sang-text)' : 'var(--ink4)' }}>{when}</span>
                    </div>
                  )
                })}
              </>
            ) : null}
          </Card>

          {/* ── 4. Models beside Telemetry ── */}
          <div className="mission-pair">
            {/* Models health (harness sprint, feature 7) — the catalog's credential availability per
                /api/models (Prometheus PR 102). `available` = provider credential present daemon-side;
                deliberately NOT GPU load (that needs a daemon /api/models/health — speced follow-up). */}
            <Card
              title={`models · ${models.length === 0 ? '—' : `${modelsReady}/${models.length} ready`}`}
              icon={<Icon name="zap" size={12} />}
              accent={defaultModel && (defaultModel.backend ? readingOf(defaultModel).state === 'down' : defaultModel.available === false) ? 'var(--sang)' : undefined}
            >
              {models.length === 0 ? (
                <span style={sentence}>Catalog unavailable.</span>
              ) : (
                models.slice(0, 5).map((entry) => {
                  // A cloud primary (Path A) rides the Local row with no health to read: it answers like its cloud row (KEY, SUB, OFF), not UP.
                  const cloudMain = !!entry.backend && isCloudPrimary(entry) && !entry.health
                  const twin = cloudMain ? cloudTwin(entry, models) : undefined
                  const m = twin ? { ...entry, available: twin.available, auth: twin.auth } : entry
                  const r = m.backend && !cloudMain ? readingOf(m) : null
                  const down = r ? r.state === 'down' : m.available === false
                  const checked = r?.checkedAt ? `last checked ${new Date(r.checkedAt).toLocaleTimeString()}` : null
                  return (
                    <div key={m.key}>
                      <div style={row} title={checked ?? undefined}>
                        <span style={dot(down ? 'var(--sang)' : r?.state === 'checking' ? 'var(--idle)' : 'var(--online)')} />
                        <span
                          style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: 'var(--ink5)' }}
                          title={[`${m.model ?? m.key}${m.provider ? ` · ${m.provider}` : ''}`, checked].filter(Boolean).join(' · ')}
                        >
                          {m.is_default || m.key === modelsDefaultKey ? defaultRowLabel(m, models) : m.label}
                          {m.is_default || m.key === modelsDefaultKey ? <span style={{ color: 'var(--ink3)' }}> · default</span> : null}
                        </span>
                        <span style={{ ...mono11, fontSize: 10, letterSpacing: '0.08em' }}>
                          {/* Backend rows (Prometheus PR 390) answer reachability; cloud rows answer credentials. */}
                          {r
                            ? r.state === 'down' ? 'DOWN' : r.state === 'checking' ? 'CHECKING' : 'UP'
                            : m.available === false ? 'OFF' : m.auth === 'subscription' ? 'SUB' : m.auth === 'api_key' ? 'KEY' : 'RDY'}
                        </span>
                      </div>
                      {r?.state === 'down' && r.reason ? (
                        <div style={{ ...sentence, fontSize: 11, paddingLeft: 14 }} title={m.health?.error ?? undefined}>
                          {r.reason}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </Card>

            <Card title="telemetry" icon={<Icon name="status" size={12} />}>
              {callsReading.kind === 'none' ? (
                <span style={sentence}>No tool calls yet.</span>
              ) : (
                <div style={{ display: 'flex', gap: 18 }}>
                  <div>
                    <div style={bigStat}>{telemetry?.total_calls ?? '—'}</div>
                    <div style={statLabel}>tool calls</div>
                  </div>
                  <div>
                    <div style={{ ...bigStat, color: successPct === null ? 'var(--ink)' : rateColor(successPct) }}>
                      {successPct === null ? '—' : `${successPct}%`}
                    </div>
                    <div style={statLabel}>success</div>
                  </div>
                </div>
              )}
              {successPct !== null ? (
                <div style={{ height: 3, borderRadius: 2, background: 'var(--line2)', overflow: 'hidden' }}>
                  <div style={{ width: `${successPct}%`, height: '100%', background: rateColor(successPct) }} />
                </div>
              ) : null}
              <button style={{ ...linkBtn, alignSelf: 'flex-start' }} onClick={() => onOpenView('toolfeed')}>
                Tool feed →
              </button>
            </Card>
          </div>

          {/* ── 5. Two one-line tiles: Sentinel · Tasks (R5). Tasks grows back into a card only when
               there are events to list. ── */}
          <div className="mission-pair">
            <EmptyRow title="sentinel" icon={<Icon name="activity" size={12} />}>
              <span style={{ fontFamily: MONO, fontSize: 12, color: sentinel?.state === 'dreaming' ? 'var(--lapis-text)' : 'var(--ink)' }}>
                {(sentinel?.state ?? '—').toUpperCase()}
              </span>
              <span style={{ ...mono11, marginLeft: 10 }}>{sentinel?.dream_count ?? '—'} dreams</span>
            </EmptyRow>
            {taskEvents.length === 0 ? (
              <EmptyRow title="tasks" icon={<Icon name="clock" size={12} />}>
                No task events yet.
              </EmptyRow>
            ) : (
              <Card title="tasks" icon={<Icon name="clock" size={12} />}>
                {taskEvents.map((t) => (
                  <div key={t.id} style={row}>
                    {/* A glyph, not a word — the raw fill colours are correct here. */}
                    <span style={{ color: t.type === 'task_failed' ? 'var(--sang)' : 'var(--online)', flexShrink: 0, display: 'inline-flex' }} aria-hidden>
                      <Icon name={t.type === 'task_failed' ? 'x' : 'check'} size={12} />
                    </span>
                    <span style={{ ...ellipsis, fontSize: 12, color: 'var(--ink5)' }} title={t.summary}>{t.summary}</span>
                    <span style={mono11}>{relTime(t.ts)}</span>
                  </div>
                ))}
              </Card>
            )}
          </div>

          {/* ── 6. Plans: the board's checklists, READ-ONLY. Ticking lives on the Board; this card
               reports and links. The chrome states its own scope, because a card headed "plans" on the
               landing view will otherwise be read as "the work", and outputs/PRs/artifacts are not here
               and mostly do not exist as data yet. ── */}
          {storiesErr ? (
            <EmptyRow title="plans" icon={<Icon name="check" size={12} />}>
              <span style={{ color: 'var(--sang-text)' }}>
                {PLAN_BANNERS.storiesUnread(storiesErr)}
              </span>
            </EmptyRow>
          ) : rollup.rows.length === 0 && rollup.unkeyable === 0 ? (
            <EmptyRow title="plans" icon={<Icon name="check" size={12} />} count={<span style={mono11}>0</span>}>
              No stories on the board yet.
            </EmptyRow>
          ) : (
            <Card
              title="plans"
              icon={<Icon name="check" size={12} />}
              right={
                <span style={mono11}>
                  {(() => {
                    const t = sumRatios(Object.values(ratios))
                    return t.total > 0 ? `${t.done}/${t.total} steps` : `${rollup.withPlan}/${rollup.rows.length}`
                  })()}
                </span>
              }
            >
              <span style={{ ...sentence, color: 'var(--ink4)', fontSize: 11 }}>
                Checklists saved under <span style={{ fontFamily: MONO }}>{PLAN_DIR}/</span> and matched to a
                story by its id. Not outputs, pull requests or artifacts — those are not tracked per story.
              </span>

              {planFilesErr ? (
                <span style={{ ...sentence, color: 'var(--sang-text)' }}>
                  {PLAN_BANNERS.listFailed(planFilesErr)}
                </span>
              ) : null}
              {planListCapped ? (
                <span style={{ ...sentence, color: 'var(--sang-text)' }}>
                  {PLAN_BANNERS.listingCapped(DOCS_LIST_CAP)}
                </span>
              ) : null}

              {rollup.rows
                .filter((r) => r.resolution.kind === 'one')
                .slice(0, PLAN_SUMMARY_READ_CAP)
                .map((r) => {
                  const ratio = ratios[r.storyId]
                  return (
                    <div key={r.storyId} style={row}>
                      <span style={{ ...mono11, color: 'var(--ink3)', width: 46 }}>{r.storyId}</span>
                      <span style={{ ...ellipsis, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--ink5)' }} title={r.title}>
                        {r.title || '(untitled)'}
                      </span>
                      {/* Absent ratio means the READ failed or has not returned — not zero steps. */}
                      <span style={mono11}>{ratio ? `${ratio.done}/${ratio.total}` : '—'}</span>
                    </div>
                  )
                })}

              {/* Coverage, stated. Two rows and a step count otherwise read as "the board is two
                  stories" — the five with nothing are the majority and they are invisible here. */}
              {rollup.withPlan > 0 ? (
                <span style={{ ...sentence, color: 'var(--ink4)', fontSize: 11 }}>
                  {rollup.withPlan} of {rollup.rows.length} {rollup.rows.length === 1 ? 'story has' : 'stories have'} a
                  plan{rollup.withPlan > ratiosRead && ratiosRead > 0 ? `; ${ratiosRead} of them read for step counts` : ''}.
                </span>
              ) : null}

              {rollup.withPlan === 0 ? (
                <span style={sentence}>
                  {planDirMissing
                    ? PLAN_BANNERS.noneSavedYet(PLAN_DIR)
                    : 'No story has a plan yet. Ask the agent for one on a dispatched task and it lands keyed to that story.'}
                </span>
              ) : null}

              {rollup.ambiguous ? (
                <span style={{ ...sentence, color: 'var(--sang-text)', fontSize: 12 }}>
                  {rollup.ambiguous} {rollup.ambiguous === 1 ? 'story matches' : 'stories match'} more than one
                  plan file. None is shown for those, on purpose — story ids are not unique, so picking one
                  could show another story's plan.
                </span>
              ) : null}
              {rollup.nearMiss ? (
                <span style={{ ...sentence, color: 'var(--ink4)', fontSize: 12 }}>
                  {rollup.nearMiss} {rollup.nearMiss === 1 ? 'story has' : 'stories have'} a file starting with
                  its id that was not claimed. Open the Board to see which and why.
                </span>
              ) : null}
              {rollup.unkeyable ? (
                <span style={{ ...sentence, color: 'var(--ink4)', fontSize: 12 }}>
                  {rollup.unkeyable} {rollup.unkeyable === 1 ? 'story has' : 'stories have'} no story id, so
                  {rollup.unkeyable === 1 ? ' it' : ' they'} can never carry a plan.
                </span>
              ) : null}

              <button style={{ ...linkBtn, alignSelf: 'flex-start' }} onClick={() => onOpenView('board')}>
                Open Board →
              </button>
            </Card>
          )}
        </>
      )}

      {/* ── 6. Recent activity: time · level chip · message, then the way to the whole feed ── */}
      <Card title="activity" icon={<Icon name="zap" size={12} />}>
        {recent.length === 0 ? (
          <span style={sentence}>Quiet so far.</span>
        ) : (
          recent.slice(0, 3).map((a) => (
            <div key={a.id} style={row}>
              <span style={{ ...mono11, width: 52, fontSize: 10 }}>{relTime(a.ts)}</span>
              <span className="mission-level" data-level={a.type.startsWith('task_') ? 'task' : 'event'}>
                {a.type.startsWith('task_') ? 'task' : a.type.replace(/_/g, ' ')}
              </span>
              <span style={{ ...ellipsis, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--ink5)' }} title={a.summary}>{a.summary}</span>
            </div>
          ))
        )}
        <button style={{ ...linkBtn, alignSelf: 'flex-start' }} onClick={() => onOpenView('activity')}>
          Open Activity →
        </button>
      </Card>

      {/* ── 7. The registry footnote ── */}
      {limited || connRefused ? null : (
        <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--ink4)' }}>
          Cloud rows show credential presence; local backends show reachability from the daemon's registry.
        </p>
      )}
    </div>
  )
}
