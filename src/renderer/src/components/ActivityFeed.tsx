import { useMemo, useState, type CSSProperties } from 'react'
import { useGateway } from '../gateway-store'
import { activitySessions, activityToJson, filterActivity, type ActivityCategory, type ActivityItem } from '@shared/gateway-events'

// Activity Feed (Phase 5a + Tier 1 controls) — every gateway frame (+ /api/events/recent backfill) as a
// filterable, searchable event list, newest first. Tier-1 controls mirror the web Activity page: pause
// (freeze the rendered snapshot while frames keep arriving in the store), clear, export-JSON, a session
// filter, and per-row copy-payload. Inline-styled.

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const CATS: ActivityCategory[] = ['message', 'tool', 'agent', 'session', 'signal', 'system']
// The category's colour AS TEXT. Two bugs lived in the old map, and they are the same bug the
// -text family exists for:
//   1. `background: ${color}22` — string-concatenating an alpha onto `var(--c-arc)` yields
//      `var(--c-arc)22`, which is INVALID AT COMPUTED-VALUE TIME and silently dropped. Measured
//      in a browser: it computes to fully transparent, so every one of these chips has been
//      rendering with NO tint at all. (`CSS.supports()` returns TRUE for it — it cannot validate
//      through var() — which is why this needed measuring rather than reasoning.)
//   2. `tool` was `--c-arc-hi` (= --sang-deep), a hover/pressed FILL, used as a 10px LABEL.
// So: a real neutral wash for the chip, and the -text variant for the word on it.
const CAT_COLOR: Record<ActivityCategory, string> = {
  message: 'var(--c-arc-text)',
  tool: 'var(--c-amber-text)',
  agent: 'var(--c-ok-text)',
  session: 'var(--ink3)',
  signal: 'var(--c-warn-text)',
  system: 'var(--c-text-dim)'
}
/** The chip's ground. One neutral wash for every category — the hue is carried by the WORD. */
const CAT_TINT = 'var(--line3)'

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', flexShrink: 0 }
/** Label and border are separate parameters on purpose: one colour driving both is how a fill
 *  ends up painting a word (see CAT_COLOR). The border may be the saturated accent; the label
 *  must be the readable one. */
const pill = (active: boolean, label: string, border: string): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 999,
  border: `1px solid ${active ? border : 'var(--c-line)'}`,
  background: active ? CAT_TINT : 'transparent',
  color: active ? label : 'var(--c-text-dim)',
  cursor: 'pointer'
})
const ctrlBtn = (active = false): CSSProperties => ({
  fontSize: 11,
  padding: '4px 10px',
  borderRadius: 6,
  border: `1px solid ${active ? 'var(--c-warn)' : 'var(--c-line)'}`,
  background: active ? 'var(--c-amber-soft)' : 'var(--c-base)',
  color: active ? 'var(--c-warn)' : 'var(--c-text)',
  cursor: 'pointer',
  font: 'inherit'
})
const selectStyle: CSSProperties = {
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  cursor: 'pointer',
  maxWidth: 220,
  font: 'inherit'
}
const expandWrap: CSSProperties = { padding: '4px 16px 10px 84px' }
const copyBtn: CSSProperties = {
  fontSize: 10,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: 'var(--c-text-dim)',
  cursor: 'pointer',
  marginBottom: 6,
  font: 'inherit'
}
const preStyle: CSSProperties = { margin: 0, fontFamily: MONO, fontSize: 11, color: 'var(--c-text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto' }

function copyText(s: string): void {
  void navigator.clipboard?.writeText(s).catch(() => undefined)
}

function payloadJson(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function timeOf(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function Row({ it }: { it: ActivityItem }) {
  const [open, setOpen] = useState(false)
  const color = CAT_COLOR[it.category]
  return (
    <div style={{ borderBottom: '1px solid var(--c-line)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
      >
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: CAT_TINT, color, flexShrink: 0, width: 58, textAlign: 'center' }}>
          {it.category}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.summary}</span>
        {it.sessionId ? (
          <span style={{ fontSize: 10, color: 'var(--c-text-faint)', fontFamily: MONO, flexShrink: 0, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.sessionId}
          </span>
        ) : null}
        <span style={{ fontSize: 11, color: 'var(--c-text-faint)', fontFamily: MONO, flexShrink: 0 }}>{timeOf(it.ts)}</span>
      </button>
      {open ? (
        <div style={expandWrap}>
          <button onClick={() => copyText(payloadJson(it.payload))} style={copyBtn} title="Copy payload JSON">
            ⧉ copy payload
          </button>
          <pre style={preStyle}>{payloadJson(it.payload)}</pre>
        </div>
      ) : null}
    </div>
  )
}

export function ActivityFeed() {
  const { activity, clearActivity } = useGateway()
  const [cats, setCats] = useState<Set<ActivityCategory>>(new Set())
  const [q, setQ] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pausedAt, setPausedAt] = useState<ActivityItem[] | null>(null)

  const paused = pausedAt !== null
  // While paused, render a frozen snapshot taken at pause time; live frames keep accumulating in the store.
  const source = pausedAt ?? activity

  const toggle = (c: ActivityCategory): void =>
    setCats((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const sessions = useMemo(() => activitySessions(source), [source])
  const rows = useMemo(() => filterActivity(source, { cats, query: q, sessionId }).slice().reverse(), [source, cats, q, sessionId])

  const exportJson = (): void => {
    const blob = new Blob([activityToJson(source)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `beacon-activity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const onClear = (): void => {
    clearActivity()
    setPausedAt(null)
    setSessionId(null)
  }

  return (
    <div style={panel}>
      <div style={head}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <p style={{ fontSize: 12, color: 'var(--c-text-dim)', margin: 0 }}>
              {rows.length} shown · {activity.length} total{paused ? ' · paused' : ''}
            </p>
          </div>
          <input
            style={{ fontSize: 12, padding: '5px 9px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', outline: 'none', width: 180 }}
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          <button style={ctrlBtn(paused)} onClick={() => setPausedAt((p) => (p ? null : activity))} title={paused ? 'Resume live updates' : 'Freeze the feed'}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button style={ctrlBtn()} onClick={onClear} title="Clear the activity feed">
            Clear
          </button>
          <button style={ctrlBtn()} onClick={exportJson} title="Download the feed as JSON">
            Export JSON
          </button>
          <select style={selectStyle} value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value || null)} title="Filter by session">
            <option value="">All sessions</option>
            {sessions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CATS.map((c) => (
            <button key={c} style={pill(cats.has(c), CAT_COLOR[c], CAT_COLOR[c])} onClick={() => toggle(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 16px', color: 'var(--c-text-dim)', fontSize: 13 }}>
            {source.length === 0 ? 'No activity yet — waiting for Prometheus events' : 'No matches'}
          </div>
        ) : (
          rows.map((it) => <Row key={it.id} it={it} />)
        )}
      </div>
    </div>
  )
}
