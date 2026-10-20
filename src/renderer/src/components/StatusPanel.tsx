import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useGateway } from '../gateway-store'
import { fmtUptime, contextUsage, segmentsAreLegible, isAuthError, type AgentStatusDTO, type ProfileDTO, type LcmStateDTO, type SentinelDTO } from '@shared/daemon-api'
import { NotAuthorized } from './NotAuthorized'

// Status view (Phase 5b) = AgentStatus + ContextInspector + Sentinel + Profiles. Polls the daemon's
// read-only REST (/api/status, /api/profiles, /api/sentinel, /api/lcm/{session}) every 4s via the
// scoped daemon.get; the live state badge also reflects agent_state frames from the gateway store.

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0 }
const body: CSSProperties = { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }
const card: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, padding: 14 }
const cardTitle: CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--c-text-faint)', marginBottom: 10 }
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '3px 0' }
const keyStyle: CSSProperties = { color: 'var(--c-text-dim)' }
const valStyle: CSSProperties = { color: 'var(--c-text)', fontFamily: 'var(--font-mono, monospace)' }

const STATE_COLOR: Record<string, string> = { thinking: 'var(--c-warn)', running: 'var(--c-warn)', idle: 'var(--c-ok)', dreaming: 'var(--c-violet)' }
const setActiveBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-arc)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{label}</span>
      <span style={valStyle}>{children}</span>
    </div>
  )
}

export function StatusPanel({ sessionId }: { sessionId: string }) {
  const { agentState } = useGateway()
  const [status, setStatus] = useState<AgentStatusDTO | null>(null)
  const [profiles, setProfiles] = useState<ProfileDTO[]>([])
  const [lcm, setLcm] = useState<LcmStateDTO | null>(null)
  const [sentinel, setSentinel] = useState<SentinelDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [authErr, setAuthErr] = useState(false)

  // Switch the agent's active profile (PUT /api/profiles/active), then re-fetch profiles + status so
  // the active dot and the Agent card update immediately (the 4s poll would also catch it).
  const switchProfile = async (name: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    try {
      await b.daemon.write('/api/profiles/active', { name }, 'PUT')
      const [p, s] = await Promise.all([b.daemon.get('/api/profiles'), b.daemon.get('/api/status')])
      setProfiles((p as ProfileDTO[]) ?? [])
      setStatus(s as AgentStatusDTO)
    } catch {
      // ignore — the next poll reflects the true daemon state
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    const get = <T,>(path: string, set: (v: T) => void): void => {
      void b.daemon
        .get(path)
        .then((d) => {
          if (alive) {
            set(d as T)
            setAuthErr(false)
          }
        })
        .catch((e) => {
          if (alive && isAuthError(e)) setAuthErr(true)
        })
    }
    const poll = (): void => {
      get<AgentStatusDTO>('/api/status', setStatus)
      get<ProfileDTO[]>('/api/profiles', (d) => setProfiles(d ?? []))
      get<SentinelDTO>('/api/sentinel', setSentinel)
      get<LcmStateDTO>(`/api/lcm/${encodeURIComponent(sessionId)}`, setLcm)
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [sessionId])

  const state = agentState ?? status?.state ?? 'idle'
  const stateColor = STATE_COLOR[state] ?? 'var(--c-text-dim)'
  // Same rule as the rail meter: an unresolved window is rendered as unknown, never as
  // 0% — which would read as an empty context rather than an unmeasured one.
  const usage = contextUsage(lcm)
  // Conservative floor for the card's bar width — it is `width: 100%` of a padded panel, so
  // 240px under-states it on any real window. Under-stating is the safe direction: it only
  // ever declines to segment something that would in fact have been visible.
  const STATUS_TRACK_PX = 240
  const showSegments =
    usage.kind === 'known' && usage.segments != null &&
    segmentsAreLegible(usage.segments, STATUS_TRACK_PX)

  if (authErr)
    return (
      <div style={panel}>
        <div style={head}>
          <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>Agent · context · sentinel · profiles</p>
        </div>
        <NotAuthorized what="status" />
      </div>
    )

  return (
    <div style={panel}>
      <div style={head}>
        <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>Agent · context · sentinel · profiles</p>
      </div>
      <div style={body}>
        <div style={card}>
          <div style={cardTitle}>Agent</div>
          <KV label="State">
            <span style={{ color: stateColor }}>● {state}</span>
          </KV>
          <KV label="Model">{status?.model ?? '—'}</KV>
          <KV label="Provider">{status?.provider ?? '—'}</KV>
          <KV label="Profile">{status?.profile ?? '—'}</KV>
          <KV label="Uptime">{fmtUptime(status?.uptime_seconds)}</KV>
        </div>

        <div style={card}>
          <div style={cardTitle}>Context window · {sessionId}</div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--c-inset)', overflow: 'hidden', margin: '4px 0 10px' }}>
            {usage.kind === 'known' && showSegments && usage.segments ? (
              <div style={{ display: 'flex', height: '100%' }}>
                <div style={{ width: `${usage.segments.summaryPct}%`, height: '100%', background: 'var(--c-violet)' }} />
                <div style={{ width: `${usage.segments.freshPct}%`, height: '100%', background: usage.pct > 90 ? 'var(--c-err)' : usage.pct > 70 ? 'var(--c-warn)' : 'var(--c-ok)' }} />
              </div>
            ) : usage.kind === 'known' ? (
              <div style={{ width: `${usage.pct}%`, height: '100%', background: usage.pct > 90 ? 'var(--c-err)' : usage.pct > 70 ? 'var(--c-warn)' : 'var(--c-ok)' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', borderTop: '1px dashed var(--c-line)' }} />
            )}
          </div>
          <KV label="Tokens">
            {usage.kind === 'known'
              ? `${usage.total.toLocaleString()} / ${usage.limit.toLocaleString()} (${usage.pct}%)`
              : `unknown — ${usage.reason}`}
          </KV>
          <KV label="Limit source">{usage.kind === 'known' ? usage.source : '—'}</KV>
          <KV label="Summarised">
            {usage.kind === 'known' && usage.segments
              ? `${usage.segments.summaryTokens.toLocaleString()} tokens`
              : '—'}
          </KV>
          <KV label="Fresh tail">
            {usage.kind === 'known' && usage.segments
              ? `${usage.segments.freshTokens.toLocaleString()} tokens`
              : '—'}
          </KV>
          <KV label="Fresh">{lcm?.fresh_count ?? 0}</KV>
          <KV label="Summaries">{lcm?.summary_count ?? 0}</KV>
          <KV label="Compression">{lcm?.compression_ratio != null ? lcm.compression_ratio.toFixed(2) : '—'}</KV>
        </div>

        <div style={card}>
          <div style={cardTitle}>Sentinel</div>
          <KV label="State">{sentinel?.state ?? '—'}</KV>
          <KV label="Dreams">{sentinel?.dream_count ?? 0}</KV>
        </div>

        <div style={card}>
          <div style={cardTitle}>Profiles</div>
          {profiles.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-dim)' }}>
              {/* Onboarding Phase 2: honest empty state instead of a bare "none". */}
              No profiles defined — profiles are named daemon presets (model + behavior) configured in
              prometheus.yaml on the host. One model is still running; see the Agent card above.
            </div>
          ) : (
            profiles.map((p) => (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.is_active ? 'var(--c-ok)' : 'var(--c-line)', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: p.is_active ? 'var(--c-text)' : 'var(--c-text-dim)', fontWeight: p.is_active ? 600 : 400, flexShrink: 0 }}>{p.name}</span>
                {p.description ? (
                  <span style={{ fontSize: 12, color: 'var(--c-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {p.description}</span>
                ) : null}
                <span style={{ flex: 1 }} />
                {p.is_active ? (
                  <span style={{ fontSize: 10, color: 'var(--c-ok)', flexShrink: 0 }}>active</span>
                ) : (
                  <button onClick={() => switchProfile(p.name)} disabled={busy} style={setActiveBtn(busy)} title={`Switch the agent to the ${p.name} profile`}>
                    Set active
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
