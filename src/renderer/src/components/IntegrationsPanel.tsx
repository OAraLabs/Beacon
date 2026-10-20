import { CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowserPayload,
  ControlsPayload,
  IntegrationEntry,
  IntegrationStatus,
  ManifestView,
  VitalsPayload
} from '@shared/integrations'
import { asBrowser, asControls, asEvents, asVitals, isAuthFailure, isSupportedViewType } from '@shared/integrations'

// Integrations — the GENERIC control-surface tab (contract v0.1). Every view
// here renders purely from manifest + wire schemas; there is deliberately no
// integration-specific code (the honesty check: if a need can't be expressed
// in the contract, the contract gets bumped, not this file). Data flows only
// through b.integrations.* IPC — main owns base URLs and auth; this renderer
// never sees a URL. Health badges use --online (red-for-healthy = alarm).
//
// Design handoff 2026-09-03 (R12–R14): the page LEADS with what is wrong. One summary line
// states the anomaly count with a "Show only problems" filter; the connector picker is a
// compact list within the page (exception-first), not a 240px column holding one card each;
// vitals rows never wrap — the state is a chip, the detail is one ellipsized line with any
// `(xN)` repeat count pulled out as a badge, and the whole detail lives in the row's tooltip.

const b = window.beacon

const panel: CSSProperties = { flex: 1, height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const head: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--c-line)', background: 'var(--c-raise)', display: 'flex', alignItems: 'center', gap: 10 }
const body: CSSProperties = { flex: 1, display: 'flex', overflow: 'hidden' }
const content: CSSProperties = { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }
const listRow = (selected: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 10, height: 32, padding: '0 10px', borderRadius: 6, cursor: 'pointer', background: selected ? 'var(--sang-soft)' : 'transparent', minWidth: 0 })
const summaryBar = (trouble: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderRadius: 8, border: `1px solid ${trouble ? 'var(--lapis)' : 'var(--c-line)'}`, background: trouble ? 'var(--lapis-soft)' : 'transparent', fontSize: 12.5, color: 'var(--c-text)' })
const countBadge: CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--ink3)', background: 'var(--line3)', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }
const ellipsis: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/** R13: `expected=True actual=True` is machine syntax — a chip says match or mismatch. */
function expectedActual(value: string): { match: boolean; expected: string; actual: string } | null {
  const m = value.match(/^expected=(\S+)\s+actual=(\S+)$/)
  return m ? { match: m[1] === m[2], expected: m[1], actual: m[2] } : null
}
/** R12's extreme case: a section of N identical "nothing to see" rows shows its count, not its rows. */
const COLLAPSE_ALL_OK_ABOVE = 5

/** R13: `… (x501)` at the end of a detail is a repeat count — a badge, not prose. */
function splitRepeat(detail: string): { text: string; times: number | null } {
  const m = detail.match(/\s*\(x(\d+)\)\s*$/)
  return m ? { text: detail.slice(0, m.index).trim(), times: Number(m[1]) } : { text: detail, times: null }
}
function healthy(h: IntegrationStatus['health']): boolean {
  return h.state === 'ok'
}
const card: CSSProperties = { background: 'var(--c-base)', border: '1px solid var(--c-line)', borderRadius: 10, padding: 14 }
const cardTitle: CSSProperties = { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--c-text-faint)', marginBottom: 8 }
const mono: CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }
const dim: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 12 }
const badge = (color: string): CSSProperties => ({ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 6 })
const tabRow: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const tabBtn = (active: boolean): CSSProperties => ({
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
  border: `1px solid ${active ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: active ? 'var(--c-arc-soft)' : 'var(--c-inset)', color: 'var(--c-text)'
})
// Disabled is a visible state (see DevicesPanel btn): one flag drives prop + style.
const btn = (disabled = false): CSSProperties => ({ padding: '5px 12px', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)' })

/** The DOT's colour — a glyph, so the raw fill values are right. */
function healthColor(h: IntegrationStatus['health']): string {
  switch (h.state) {
    case 'ok': return 'var(--online)'
    case 'degraded': return 'var(--c-warn)'
    case 'disabled': return 'var(--c-text-faint)'
    default: return 'var(--c-err)'
  }
}

/** The LABEL's colour — a word, so it takes the -text variants (scripts/check-contrast.mjs). */
function healthTextColor(h: IntegrationStatus['health']): string {
  switch (h.state) {
    case 'ok': return 'var(--c-ok-text)'
    case 'degraded': return 'var(--c-warn-text)'
    case 'disabled': return 'var(--c-text-faint)'
    default: return 'var(--c-err-text)'
  }
}

function healthLabel(h: IntegrationStatus['health']): string {
  switch (h.state) {
    case 'ok': return 'healthy'
    case 'degraded': return `degraded (${h.degraded.length})`
    case 'disabled': return 'disconnected'
    case 'unreachable': return isAuthFailure(h.detail) ? 'AUTH FAILED (401)' : 'unreachable'
    case 'version-mismatch': return `contract v${h.got} ≠ v${h.want}`
    default: return 'error'
  }
}

// ── Vitals renderer (contract §3.1) ─────────────────────────────────────

function VitalsView({ id, view, onlyProblems }: { id: string; view: ManifestView; onlyProblems: boolean }) {
  const [data, setData] = useState<VitalsPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let alive = true
    const load = (): void => {
      b.integrations.get(id, view.endpoint ?? '').then(
        (raw) => alive && (setData(asVitals(raw)), setErr(null)),
        (e) => alive && setErr(String(e).slice(0, 200))
      )
    }
    load()
    const t = setInterval(load, Math.max(5, view.poll_seconds ?? 15) * 1000)
    return () => { alive = false; clearInterval(t) }
  }, [id, view.endpoint, view.poll_seconds])
  if (err) return <div style={{ ...card, color: 'var(--c-err)' }}>vitals failed: {err}</div>
  if (!data) return <div style={dim}>loading vitals…</div>
  const rank = (st: string | null | undefined): number => (st === 'error' ? 0 : st === 'warn' ? 1 : st === 'ok' ? 3 : 2)
  return (
    <>
      {data.sections.map((s) => {
        const rows = [...s.rows].sort((a, z) => rank(a.status) - rank(z.status))
        const bad = rows.filter((r) => r.status === 'error' || r.status === 'warn').length
        const okCount = rows.filter((r) => r.status === 'ok').length
        const off = rows.length - bad - okCount // disabled / unknown: not wrong, not healthy
        const allOk = bad === 0 && off === 0
        // A section that is entirely "nothing to see" (and long) collapses to its count; a click
        // lists the rows. Anything with a problem or an off row stays open.
        const collapsed = allOk && rows.length > COLLAPSE_ALL_OK_ABOVE && !opened[s.title]
        const shown = collapsed ? [] : onlyProblems ? rows.filter((r) => r.status !== 'ok') : rows
        const headline = bad
          ? `${bad} problem${bad === 1 ? '' : 's'}${off ? ` · ${off} off` : ''}`
          : off
            ? `${okCount} ok · ${off} off`
            : `${rows.length} ok`
        return (
          <div key={s.title} style={card} data-testid="vitals-section" data-collapsed={collapsed ? '1' : '0'}>
            <div style={{ ...cardTitle, display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ flex: 1 }}>{s.title}</span>
              <span style={{ letterSpacing: 0, textTransform: 'none', color: bad ? 'var(--lapis-text)' : 'var(--ink4)' }}>{headline}</span>
              {allOk && rows.length > COLLAPSE_ALL_OK_ABOVE ? (
                <button style={{ background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 11, letterSpacing: 0, textTransform: 'none', color: 'var(--lapis-text)', cursor: 'pointer' }} onClick={() => setOpened((o) => ({ ...o, [s.title]: !o[s.title] }))} aria-expanded={!collapsed}>
                  {collapsed ? 'Show all' : 'Hide'}
                </button>
              ) : null}
            </div>
            {!collapsed && shown.length === 0 ? <div style={{ ...dim, fontFamily: 'var(--font-body)' }}>Nothing wrong here.</div> : null}
            {shown.map((r, i) => {
              const d = r.detail ? splitRepeat(r.detail) : null
              const ok = r.status === 'ok'
              return (
                <div
                  key={i}
                  data-testid="vitals-row"
                  data-status={r.status ?? 'unknown'}
                  title={r.detail ? `${r.label} — ${r.value}\n${r.detail}` : `${r.label} — ${r.value}`}
                  style={{ display: 'flex', gap: 8, height: 26, alignItems: 'center', minWidth: 0 }}
                >
                  <span style={badge(ok ? 'var(--online)' : r.status === 'warn' ? 'var(--c-warn)' : r.status === 'error' ? 'var(--c-err)' : 'var(--c-text-faint)')} />
                  <span style={{ ...mono, width: 180, flexShrink: 0, ...ellipsis }}>{r.label}</span>
                  {(() => {
                    const ea = expectedActual(String(r.value ?? ''))
                    if (!ea) return <span style={{ fontSize: 12, width: ok ? 'auto' : 150, flexShrink: 0, ...ellipsis }}>{r.value}</span>
                    return ea.match ? (
                      <span style={{ ...mono, fontSize: 10, color: 'var(--c-ok-text)', letterSpacing: '0.06em' }}>match</span>
                    ) : (
                      <span style={{ ...mono, fontSize: 11, color: 'var(--c-err-text)' }} title={String(r.value)}>expected {ea.expected} · actual {ea.actual}</span>
                    )
                  })()}
                  {/* Healthy rows shrink to name · state · value. Detail belongs behind the row (its
                      tooltip), and a problem's detail is ONE ellipsized line with the count out front. */}
                  {!ok && d ? (
                    <>
                      {d.times !== null ? <span style={countBadge}>×{d.times}</span> : null}
                      <span style={{ ...dim, fontSize: 11, flex: 1, ...ellipsis }}>{d.text}</span>
                    </>
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}

// ── Browser renderer (contract §3.2) ────────────────────────────────────

function BrowserView({ id, view }: { id: string; view: ManifestView }) {
  const [data, setData] = useState<BrowserPayload | null>(null)
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const limit = 50
  useEffect(() => {
    let alive = true
    const qs = `?limit=${limit}&offset=${offset}${view.searchable && q ? `&q=${encodeURIComponent(q)}` : ''}`
    b.integrations.get(id, `${view.endpoint}${qs}`).then(
      (raw) => alive && (setData(asBrowser(raw)), setErr(null)),
      (e) => alive && setErr(String(e).slice(0, 200))
    )
    return () => { alive = false }
  }, [id, view.endpoint, view.searchable, q, offset])
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        {view.searchable ? (
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0) }}
            placeholder="search…"
            style={{ ...mono, background: 'var(--c-inset)', border: '1px solid var(--c-line)', borderRadius: 6, padding: '4px 8px', color: 'var(--c-text)', flex: 1 }}
          />
        ) : <span style={dim}>{view.title}</span>}
        <span style={dim}>{data ? `${data.total} total` : ''}</span>
        <button style={btn(offset === 0)} disabled={offset === 0} title={offset === 0 ? 'Already at the first page' : 'Previous page'} onClick={() => setOffset(Math.max(0, offset - limit))}>‹</button>
        <button style={btn(!data || offset + limit >= data.total)} disabled={!data || offset + limit >= data.total} title={!data || offset + limit >= data.total ? 'No more pages' : 'Next page'} onClick={() => setOffset(offset + limit)}>›</button>
      </div>
      {err ? <div style={{ color: 'var(--c-err)', fontSize: 12 }}>browse failed: {err}</div> : null}
      {data && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>{data.columns.map((c) => <th key={c.key} style={{ ...cardTitle, textAlign: 'left', padding: '2px 8px 6px 0' }}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--c-line)' }}>
                  {data.columns.map((c) => {
                    const v = row[c.key]
                    const text = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
                    return <td key={c.key} style={{ ...mono, padding: '4px 8px 4px 0', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>{text.slice(0, 200)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Controls renderer (contract §3.3) — two-step confirm for confirm:true ─

function ControlsView({ id, view }: { id: string; view: ManifestView }) {
  const [data, setData] = useState<ControlsPayload | null>(null)
  const [arming, setArming] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    b.integrations.get(id, view.endpoint ?? '').then(
      (raw) => alive && (setData(asControls(raw)), setErr(null)),
      (e) => alive && setErr(String(e).slice(0, 200))
    )
    return () => { alive = false }
  }, [id, view.endpoint])
  const run = useCallback((c: ControlsPayload['controls'][number]): void => {
    setArming(null)
    setResult((r) => ({ ...r, [c.id]: 'running…' }))
    b.integrations.invoke(id, c.endpoint, c.method).then(
      (raw) => {
        const o = (raw ?? {}) as { ok?: boolean; message?: string }
        setResult((r) => ({ ...r, [c.id]: `${o.ok ? '✓' : '✗'} ${o.message ?? ''}`.trim() }))
      },
      (e) => setResult((r) => ({ ...r, [c.id]: `✗ ${String(e).slice(0, 160)}` }))
    )
  }, [id])
  if (err) return <div style={{ ...card, color: 'var(--c-err)' }}>controls failed: {err}</div>
  if (!data) return <div style={dim}>loading controls…</div>
  return (
    <div style={card}>
      <div style={cardTitle}>{view.title}</div>
      {data.controls.map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: 10, padding: '6px 0', alignItems: 'center', borderTop: '1px solid var(--c-line)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13 }}>{c.label}</div>
            {c.description ? <div style={{ ...dim, fontSize: 11 }}>{c.description}</div> : null}
            {result[c.id] ? <div style={{ ...mono, fontSize: 11, color: result[c.id].startsWith('✗') ? 'var(--c-err)' : 'var(--c-text-dim)' }}>{result[c.id]}</div> : null}
          </div>
          {c.confirm && arming === c.id ? (
            <>
              <button style={{ ...btn(), borderColor: c.danger ? 'var(--c-err)' : 'var(--c-arc)', color: c.danger ? 'var(--c-err)' : 'var(--c-text)' }} onClick={() => run(c)}>
                Confirm {c.danger ? '(danger)' : ''}
              </button>
              <button style={btn()} onClick={() => setArming(null)}>Cancel</button>
            </>
          ) : (
            <button style={{ ...btn(), borderColor: c.danger ? 'var(--c-err)' : 'var(--c-line)' }} onClick={() => (c.confirm ? setArming(c.id) : run(c))}>
              {c.label.length > 24 ? 'Run' : c.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Events renderer (contract §3.4) — cursor poll (the universal transport;
//    WS is declared in the manifest but polling also sees external DB writers,
//    per the middleware's own caveat) ─────────────────────────────────────

function EventsView({ id, view }: { id: string; view: ManifestView }) {
  const [events, setEvents] = useState<Record<string, unknown>[]>([])
  const [err, setErr] = useState<string | null>(null)
  const cursor = useRef<number | string>(0)
  useEffect(() => {
    let alive = true
    setEvents([]); cursor.current = 0
    const endpoint = view.poll_endpoint ?? view.endpoint ?? ''
    const load = (): void => {
      b.integrations.get(id, `${endpoint}?since=${cursor.current}&limit=100`).then(
        (raw) => {
          if (!alive) return
          const p = asEvents(raw)
          cursor.current = p.cursor
          if (p.events.length) setEvents((prev) => [...p.events.reverse(), ...prev].slice(0, 300))
          setErr(null)
        },
        (e) => alive && setErr(String(e).slice(0, 200))
      )
    }
    load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [id, view.endpoint, view.poll_endpoint])
  return (
    <div style={card}>
      <div style={cardTitle}>{view.title} {err ? <span style={{ color: 'var(--c-err)' }}>— poll failed: {err}</span> : null}</div>
      {events.length === 0 ? <div style={dim}>no events yet — they stream in as the integration writes them</div> : null}
      {events.map((e, i) => (
        <div key={i} style={{ ...mono, fontSize: 11, padding: '3px 0', borderTop: '1px solid var(--c-line)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={JSON.stringify(e)}>
          <span style={{ color: 'var(--c-text-faint)' }}>{String(e.timestamp ?? '')}</span>{' '}
          <span style={{ color: 'var(--c-arc)' }}>{String(e.source ?? '')}</span>/{String(e.event_type ?? '')}{' '}
          <span style={dim}>{e.data ? JSON.stringify(e.data).slice(0, 160) : ''}</span>
        </div>
      ))}
    </div>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────

export function IntegrationsPanel() {
  const [statuses, setStatuses] = useState<IntegrationStatus[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState(0)
  // Inline token editor — Electron has no window.prompt(), so the "Set token…"
  // button opens this controlled field instead. tokenFor = which entry's field
  // is open; the value never round-trips back from main (write-only).
  const [tokenFor, setTokenFor] = useState<string | null>(null)
  const [tokenValue, setTokenValue] = useState('')
  const saveToken = useCallback((id: string): void => {
    void b.integrations.setToken(id, tokenValue).then(() => {
      setTokenFor(null)
      setTokenValue('')
      return b.integrations.status().then(setStatuses)
    })
  }, [tokenValue])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      b.integrations.status().then((s) => {
        if (!alive) return
        setStatuses(s)
        if (!selected && s.length) setSelected(s[0].entry.id)
      }, () => alive && setStatuses([]))
    }
    load()
    const t = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [selected])
  const toggle = useCallback((entry: IntegrationEntry): void => {
    const next = (statuses ?? []).map((s) => (s.entry.id === entry.id ? { ...s.entry, enabled: !s.entry.enabled } : s.entry))
    void b.integrations.save(next).then(() => b.integrations.status().then(setStatuses))
  }, [statuses])

  const sel = statuses?.find((s) => s.entry.id === selected) ?? null
  const views = sel?.manifest?.views ?? []
  const active = views[tab]
  const [onlyProblems, setOnlyProblems] = useState(false)
  // R12: exceptions first. The list is sorted, the summary counts, the filter hides the healthy.
  const rankHealth = (h: IntegrationStatus['health']): number => (h.state === 'ok' ? 3 : h.state === 'disabled' ? 2 : h.state === 'degraded' ? 1 : 0)
  const ordered = [...(statuses ?? [])].sort((a, z) => rankHealth(a.health) - rankHealth(z.health))
  const unhealthy = ordered.filter((s) => !healthy(s.health)).length
  const listed = onlyProblems ? ordered.filter((s) => !healthy(s.health)) : ordered

  return (
    <div style={panel}>
      <div style={head}>
        <span style={dim}>Other apps' status and controls</span>
      </div>
      <div style={{ ...body, flexDirection: 'column', overflowY: 'auto' }}>
        <div style={{ padding: '12px 14px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {statuses !== null && statuses.length > 0 ? (
            <div style={summaryBar(unhealthy > 0)} data-testid="integrations-summary">
              <span style={badge(unhealthy > 0 ? 'var(--lapis)' : 'var(--online)')} />
              <span style={{ flex: 1 }}>
                {unhealthy > 0 ? `${unhealthy} of ${statuses.length} integration${statuses.length === 1 ? '' : 's'} not healthy` : `${statuses.length} integration${statuses.length === 1 ? '' : 's'} · all healthy`}
              </span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--c-text-dim)', cursor: 'pointer' }}>
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                Show only problems
              </label>
            </div>
          ) : null}
          {statuses === null ? <div style={dim}>loading…</div> : null}
          {statuses?.length === 0 ? (
            // Plain words and a next step you can press (the 0.4.5 sweep, E3: "pure-Prometheus", "the app's user-data folder").
            <div style={{ ...dim, padding: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
              <span>
                No integrations yet. An integration puts another app&apos;s status and controls on this page. To add one, add it to
                Beacon&apos;s integrations file.
              </span>
              <button style={btn()} onClick={() => void b.integrations.reveal().catch(() => undefined)}>
                Show the file
              </button>
            </div>
          ) : null}
          {/* R14: the connector picker is a list within the page — one 32px row each, name ·
              state · actions — not a column of cards beside the content. */}
          {listed.map((s) => (
            <div key={s.entry.id} data-testid="integration-row" data-health={s.health.state}>
              <div
                onClick={() => { setSelected(s.entry.id); setTab(0) }}
                style={listRow(selected === s.entry.id)}
                title={s.health.state === 'version-mismatch' ? 'contract mismatch — integration disabled (loud by design)' : 'degraded' in s.health && s.health.degraded.length ? s.health.degraded.map((d) => `${d.component}: ${d.reason}`).join('\n') : healthLabel(s.health)}
              >
                <span style={badge(healthColor(s.health))} />
                <span style={{ fontSize: 13, width: 160, flexShrink: 0, ...ellipsis }}>{s.entry.name}</span>
                <span style={{ ...mono, fontSize: 11, color: healthy(s.health) ? 'var(--c-text-dim)' : healthTextColor(s.health), width: 150, flexShrink: 0, ...ellipsis }}>{healthLabel(s.health)}</span>
                <span style={{ ...dim, fontSize: 11, flex: 1, ...ellipsis }}>
                  {s.health.state === 'version-mismatch'
                    ? 'contract mismatch — disabled'
                    : 'degraded' in s.health && s.health.degraded.length
                      ? s.health.degraded.map((d) => `${d.component}: ${d.reason}`).join(' · ')
                      : ''}
                </span>
                <button style={{ ...btn(), fontSize: 11, padding: '3px 9px' }} onClick={(e) => { e.stopPropagation(); toggle(s.entry) }}>
                  {s.entry.enabled ? 'Disconnect' : 'Connect'}
                </button>
                <button style={{ ...btn(), fontSize: 11, padding: '3px 9px' }} onClick={(e) => {
                  e.stopPropagation()
                  setTokenFor(tokenFor === s.entry.id ? null : s.entry.id)
                  setTokenValue('')
                }}>
                  Set token…
                </button>
              </div>
              {tokenFor === s.entry.id ? (
                <div onClick={(e) => e.stopPropagation()} style={{ margin: '4px 10px 6px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input
                    type="password"
                    autoFocus
                    value={tokenValue}
                    onChange={(e) => setTokenValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveToken(s.entry.id); if (e.key === 'Escape') setTokenFor(null) }}
                    placeholder="bearer token (blank clears)"
                    style={{ ...mono, flex: 1, minWidth: 140, background: 'var(--c-inset)', border: '1px solid var(--c-line)', borderRadius: 6, padding: '4px 8px', color: 'var(--c-text)' }}
                  />
                  <button style={{ ...btn(), fontSize: 11, borderColor: 'var(--c-arc)' }} onClick={() => saveToken(s.entry.id)}>Save</button>
                  <button style={{ ...btn(), fontSize: 11 }} onClick={() => setTokenFor(null)}>Cancel</button>
                </div>
              ) : null}
              {s.health.state === 'unreachable' && isAuthFailure((s.health as { detail: string }).detail) ? (
                <div style={{ color: 'var(--c-err-text)', fontSize: 11, margin: '0 10px 6px' }}>
                  bearer token missing or rejected — set it above (loud by design, never an empty view)
                </div>
              ) : null}
            </div>
          ))}
          {onlyProblems && listed.length === 0 && (statuses?.length ?? 0) > 0 ? <div style={{ ...dim, fontFamily: 'var(--font-body)' }}>Every integration is healthy.</div> : null}
        </div>
        <div style={content}>
          {!sel ? <div style={dim}>select an integration</div> : null}
          {sel && sel.health.state === 'version-mismatch' ? (
            <div style={{ ...card, color: 'var(--c-err)' }}>
              This integration speaks contract v{(sel.health as { got: number }).got}; Beacon supports v
              {(sel.health as { want: number }).want}. It has been disabled rather than rendered wrong.
            </div>
          ) : null}
          {sel && sel.manifest && sel.health.state !== 'version-mismatch' ? (
            <>
              {/* What this integration can DO, as distinct from what it can SHOW.
                  Still no integration-specific code: the panel renders whatever the
                  manifest declares. It is the reason Beacon's voice/dictation
                  dependency is visible here at all instead of living only in a
                  hand-edited entry nobody can see (B6). An integration that
                  declares nothing simply gets no card. */}
              {sel.manifest.capabilities.length > 0 ? (
                <div style={card}>
                  <div style={cardTitle}>Capabilities</div>
                  {sel.manifest.capabilities.map((c) => (
                    <div key={c.id} style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 13 }}>{c.title}</span>
                      <span style={{ ...mono, color: 'var(--c-text-faint)', marginLeft: 8 }}>{c.id}</span>
                      {c.detail ? <div style={dim}>{c.detail}</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={tabRow}>
                {views.map((v, i) => (
                  <span key={i} style={tabBtn(i === tab)} onClick={() => setTab(i)}>
                    {v.title}{!isSupportedViewType(v.type) ? ' (unsupported)' : ''}
                  </span>
                ))}
              </div>
              {active && isSupportedViewType(active.type) ? (
                active.type === 'vitals' ? <VitalsView id={sel.entry.id} view={active} onlyProblems={onlyProblems} /> :
                active.type === 'browser' ? <BrowserView id={sel.entry.id} view={active} /> :
                active.type === 'controls' ? <ControlsView id={sel.entry.id} view={active} /> :
                <EventsView id={sel.entry.id} view={active} />
              ) : active ? (
                <div style={{ ...card, color: 'var(--c-warn)' }}>
                  view type “{active.type}” is not part of contract v1 — shown, not hidden
                </div>
              ) : null}
            </>
          ) : null}
          {sel && !sel.manifest && sel.health.state === 'unreachable' ? (
            <div style={{ ...card, color: 'var(--c-err)' }}>unreachable: {(sel.health as { detail: string }).detail}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
